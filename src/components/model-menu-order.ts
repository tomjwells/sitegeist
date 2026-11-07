/**
 * Row order for the model menu (src/components/ModelMenu.ts). Pure, so tests/model-menu-order.test.ts runs it under
 * plain node: recently picked models first ("Recent"), then one group per provider, models sorted by name with
 * numbers compared as numbers (claude-opus-5-5 after claude-opus-4-8). A filter keeps rows whose name, id and
 * provider contain every typed word; while filtering, recents are not repeated at the top.
 */
import type { Model } from "@mariozechner/pi-ai";

export interface ModelRow {
	group: string;
	model: Model<any>;
}

const key = (m: Pick<Model<any>, "provider" | "id">): string => `${m.provider}/${m.id}`;

export function orderModels(models: readonly Model<any>[], query: string, recent: readonly string[]): ModelRow[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const seen = new Set<string>();
	const unique = models.filter((m) => {
		const k = key(m);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const matches = (m: Model<any>): boolean => {
		if (terms.length === 0) return true;
		const hay = `${m.provider} ${m.id} ${m.name ?? ""}`.toLowerCase();
		return terms.every((t) => hay.includes(t));
	};
	const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
	const rows: ModelRow[] = [];
	if (terms.length === 0) {
		for (const r of recent) {
			const m = unique.find((x) => key(x) === r);
			if (m) rows.push({ group: "Recent", model: m });
		}
	}
	const groups = new Map<string, Model<any>[]>();
	for (const m of unique) {
		if (!matches(m)) continue;
		const list = groups.get(m.provider) ?? [];
		list.push(m);
		groups.set(m.provider, list);
	}
	for (const provider of [...groups.keys()].sort((a, b) => byName.compare(a, b))) {
		const list = groups.get(provider) ?? [];
		list.sort((a, b) => byName.compare(a.name || a.id, b.name || b.id));
		for (const m of list) rows.push({ group: provider, model: m });
	}
	return rows;
}
