import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "..", "data");

export interface CatalogEntry {
  id: number;
  slug: string;
  title: string;
  category: string;
  name: string;
  w: number;
  h: number;
}

let catalog: CatalogEntry[] | null = null;

function loadCatalog(): CatalogEntry[] {
  if (!catalog) {
    const raw = fs.readFileSync(path.join(dataDir, "oci-catalog.json"), "utf8");
    catalog = JSON.parse(raw) as CatalogEntry[];
  }
  return catalog;
}

export function getCategories(): { name: string; count: number }[] {
  const entries = loadCatalog();
  const cats = new Map<string, number>();
  for (const entry of entries) {
    cats.set(entry.category, (cats.get(entry.category) || 0) + 1);
  }
  return [...cats.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function listShapes(category?: string): CatalogEntry[] {
  const entries = loadCatalog();
  if (!category) return entries;
  const lower = category.toLowerCase();
  return entries.filter((e) => e.category.toLowerCase() === lower);
}

export function searchShapes(query: string): CatalogEntry[] {
  const entries = loadCatalog();
  const terms = query.toLowerCase().split(/\s+/);
  return entries.filter((e) => {
    const text = `${e.title} ${e.slug}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function getShapeById(id: number): CatalogEntry | undefined {
  const entries = loadCatalog();
  return entries.find((e) => e.id === id);
}

export function getShapeBySlug(slug: string): CatalogEntry | undefined {
  const entries = loadCatalog();
  return entries.find((e) => e.slug === slug);
}
