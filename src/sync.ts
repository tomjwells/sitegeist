import { getSitegeistStorage } from "./storage/app-storage.js";
import type { Skill } from "./storage/stores/skills-store.js";

/**
 * Server-side sync of user-authored skills and custom instructions, so a reinstall (or another
 * browser) re-hydrates instead of losing them. The server is a plain file store with
 * last-write-wins on the entity's own timestamp and tombstones for deletes:
 *   GET    <base>/sync                  -> { skills, tombstones, instructions }
 *   PUT    <base>/skills/<name>         <- Skill
 *   DELETE <base>/skills/<name>
 *   PUT    <base>/instructions          <- { text, updatedAt }
 * Everything is best effort: a missing/unreachable server only logs to the console.
 */
export const SYNC_URL_SETTING = "sync.url";
export const DEFAULT_SYNC_URL = "https://cors-proxy.tjw-private/sitegeist";
export const CUSTOM_INSTRUCTIONS_UPDATED_SETTING = "customInstructionsUpdatedAt";
/** Also mirror provider logins (API keys / OAuth tokens) to the sync server. Default on. */
export const SYNC_AUTH_SETTING = "sync.auth";

const TIMEOUT_MS = 8000;

interface ServerInstructions {
	text: string;
	updatedAt: string;
}

interface SyncDocument {
	skills: Skill[];
	tombstones: Record<string, string>;
	instructions: ServerInstructions | null;
}

export interface SyncResult {
	ok: boolean;
	pulledSkills: number;
	pushedSkills: number;
	deletedSkills: number;
	instructions: "pulled" | "pushed" | "same" | "none";
	pulledLogins: number;
	pushedLogins: number;
	error?: string;
}

interface AuthDocument {
	keys: Record<string, string>;
	updatedAt: string;
}

function isAuthDocument(v: unknown): v is AuthDocument {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.keys === "object" &&
		o.keys !== null &&
		Object.values(o.keys as Record<string, unknown>).every(isString) &&
		isString(o.updatedAt)
	);
}

const isString = (v: unknown): v is string => typeof v === "string";

function isSkill(v: unknown): v is Skill {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		isString(o.name) &&
		Array.isArray(o.domainPatterns) &&
		o.domainPatterns.every(isString) &&
		isString(o.shortDescription) &&
		isString(o.description) &&
		isString(o.createdAt) &&
		isString(o.lastUpdated) &&
		isString(o.examples) &&
		isString(o.library)
	);
}

function isSyncDocument(v: unknown): v is SyncDocument {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	if (!Array.isArray(o.skills) || !o.skills.every(isSkill)) return false;
	if (typeof o.tombstones !== "object" || o.tombstones === null) return false;
	if (!Object.values(o.tombstones as Record<string, unknown>).every(isString)) return false;
	if (o.instructions === null) return true;
	if (typeof o.instructions !== "object" || o.instructions === null) return false;
	const ins = o.instructions as Record<string, unknown>;
	return isString(ins.text) && isString(ins.updatedAt);
}

async function baseUrl(): Promise<string | undefined> {
	const url = ((await getSitegeistStorage().settings.get<string>(SYNC_URL_SETTING)) ?? DEFAULT_SYNC_URL).trim();
	return url ? url.replace(/\/+$/, "") : undefined;
}

async function request(method: string, path: string, body?: unknown): Promise<Response | undefined> {
	const base = await baseUrl();
	if (!base) return undefined;
	const init: RequestInit = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}
	return fetch(`${base}${path}`, init);
}

const skillPath = (name: string) => `/skills/${encodeURIComponent(name)}`;

/** Push one skill; called after every local save. */
export async function pushSkill(skill: Skill): Promise<void> {
	try {
		const res = await request("PUT", skillPath(skill.name), skill);
		if (res && !res.ok && res.status !== 409) console.warn(`[Sync] push skill "${skill.name}" failed: ${res.status}`);
	} catch (e) {
		console.warn("[Sync] push skill failed:", e);
	}
}

/** Record a delete on the server (tombstone); called after every local delete. */
export async function pushSkillDelete(name: string): Promise<void> {
	try {
		const res = await request("DELETE", skillPath(name));
		if (res && !res.ok) console.warn(`[Sync] delete skill "${name}" failed: ${res.status}`);
	} catch (e) {
		console.warn("[Sync] delete skill failed:", e);
	}
}

/** Push the custom instructions; called after every save in Settings → Instructions. */
export async function pushInstructions(text: string, updatedAt: string): Promise<void> {
	try {
		const res = await request("PUT", "/instructions", { text, updatedAt });
		if (res && !res.ok && res.status !== 409) console.warn(`[Sync] push instructions failed: ${res.status}`);
	} catch (e) {
		console.warn("[Sync] push instructions failed:", e);
	}
}

async function authSyncEnabled(): Promise<boolean> {
	return (await getSitegeistStorage().settings.get<boolean>(SYNC_AUTH_SETTING)) !== false;
}

/** Mirror one provider login; called after every providerKeys.set(). */
export async function pushAuthKey(provider: string, key: string): Promise<void> {
	if (!(await authSyncEnabled())) return;
	try {
		const res = await request("PUT", `/auth/${encodeURIComponent(provider)}`, { key });
		if (res && !res.ok) console.warn(`[Sync] push login "${provider}" failed: ${res.status}`);
	} catch (e) {
		console.warn("[Sync] push login failed:", e);
	}
}

/** Remove one provider login from the server; called after every providerKeys.delete(). */
export async function pushAuthDelete(provider: string): Promise<void> {
	if (!(await authSyncEnabled())) return;
	try {
		const res = await request("DELETE", `/auth/${encodeURIComponent(provider)}`);
		if (res && !res.ok) console.warn(`[Sync] delete login "${provider}" failed: ${res.status}`);
	} catch (e) {
		console.warn("[Sync] delete login failed:", e);
	}
}

/**
 * Logins: union of both sides, local wins on conflict (OAuth refresh tokens rotate, and the browser
 * that used one last holds the live pair). Fills the local store after a reinstall.
 */
async function syncLogins(result: SyncResult): Promise<void> {
	if (!(await authSyncEnabled())) return;
	const res = await request("GET", "/auth");
	if (!res) return;
	if (!res.ok) throw new Error(`GET /auth -> ${res.status}`);
	const doc: unknown = await res.json();
	if (!isAuthDocument(doc)) throw new Error("unexpected /auth response shape");
	const keys = getSitegeistStorage().providerKeys;
	const localProviders = new Set(await keys.list());
	for (const [provider, key] of Object.entries(doc.keys)) {
		if (localProviders.has(provider)) continue;
		await keys.set(provider, key, { sync: false });
		result.pulledLogins++;
	}
	for (const provider of localProviders) {
		const key = await keys.get(provider);
		if (key === null || doc.keys[provider] === key) continue;
		await pushAuthKey(provider, key);
		result.pushedLogins++;
	}
}

/**
 * Two-way reconcile with the server. Per skill (by name): newer `lastUpdated` wins; a skill only on
 * one side is copied to the other unless the server holds a tombstone newer than the local copy, in
 * which case the local copy is deleted. Instructions: newer `updatedAt` wins.
 */
export async function syncWithServer(): Promise<SyncResult> {
	const result: SyncResult = {
		ok: false,
		pulledSkills: 0,
		pushedSkills: 0,
		deletedSkills: 0,
		instructions: "none",
		pulledLogins: 0,
		pushedLogins: 0,
	};
	const storage = getSitegeistStorage();
	const skills = storage.skills;
	try {
		const res = await request("GET", "/sync");
		if (!res) {
			result.error = "sync disabled (no URL)";
			return result;
		}
		if (!res.ok) throw new Error(`GET /sync -> ${res.status}`);
		const doc: unknown = await res.json();
		if (!isSyncDocument(doc)) throw new Error("unexpected /sync response shape");

		const local = new Map((await skills.list()).map((s) => [s.name, s]));
		const remote = new Map(doc.skills.map((s) => [s.name, s]));

		for (const [name, remoteSkill] of remote) {
			const localSkill = local.get(name);
			if (!localSkill || localSkill.lastUpdated < remoteSkill.lastUpdated) {
				await skills.save(remoteSkill, { sync: false });
				result.pulledSkills++;
			} else if (localSkill.lastUpdated > remoteSkill.lastUpdated) {
				await pushSkill(localSkill);
				result.pushedSkills++;
			}
		}
		for (const [name, localSkill] of local) {
			if (remote.has(name)) continue;
			const deletedAt = doc.tombstones[name];
			if (deletedAt !== undefined && deletedAt > localSkill.lastUpdated) {
				await skills.delete(name, { sync: false });
				result.deletedSkills++;
			} else {
				await pushSkill(localSkill);
				result.pushedSkills++;
			}
		}

		const settings = storage.settings;
		const localText = ((await settings.get<string>("customInstructions")) ?? "").trim();
		const localAt = (await settings.get<string>(CUSTOM_INSTRUCTIONS_UPDATED_SETTING)) ?? "";
		const remoteIns = doc.instructions;
		if (remoteIns && (localAt === "" || remoteIns.updatedAt > localAt) && remoteIns.text !== localText) {
			await settings.set("customInstructions", remoteIns.text);
			await settings.set(CUSTOM_INSTRUCTIONS_UPDATED_SETTING, remoteIns.updatedAt);
			result.instructions = "pulled";
		} else if (localText && (!remoteIns || remoteIns.text !== localText)) {
			const at = localAt || new Date().toISOString();
			if (!localAt) await settings.set(CUSTOM_INSTRUCTIONS_UPDATED_SETTING, at);
			await pushInstructions(localText, at);
			result.instructions = "pushed";
		} else if (remoteIns || localText) {
			result.instructions = "same";
		}
		await syncLogins(result);
		result.ok = true;
		console.log("[Sync] done:", result);
	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e);
		console.warn("[Sync] failed:", result.error);
	}
	return result;
}
