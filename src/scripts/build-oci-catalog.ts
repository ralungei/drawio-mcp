#!/usr/bin/env node

/**
 * Parses data/oci-library.xml and generates:
 *   data/oci-catalog.json — lightweight catalog for LLM discovery
 *   data/oci-shapes.json  — full shape data indexed by id
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const dataDir = path.join(projectRoot, "data");

interface LibraryEntry {
  xml: string;
  w: number;
  h: number;
  aspect?: string;
  title?: string;
}

interface CatalogEntry {
  id: number;
  slug: string;
  title: string;
  category: string;
  name: string;
  w: number;
  h: number;
}

interface ShapeEntry {
  xml: string;
  w: number;
  h: number;
  title: string;
}

function toSlug(title: string): string {
  // "Compute - Bare Metal Compute" → "compute/bare_metal_compute"
  const parts = title.split(" - ");
  const category = parts[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
  const name = parts.slice(1).join(" - ").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
  return `${category}/${name}`;
}

function normalizeCategory(raw: string): string {
  // Fix &nbsp; / &amp;nbsp; issues: "Analytics and AI -&amp;nbsp;Data Catalog" → "Analytics and AI"
  return raw.replace(/\s*-\s*(&amp;nbsp;|&nbsp;).*$/, "").replace(/(&amp;nbsp;|&nbsp;)/g, " ").trim();
}

function main(): void {
  const xmlPath = path.join(dataDir, "oci-library.xml");
  const raw = fs.readFileSync(xmlPath, "utf8");

  const match = raw.match(/<mxlibrary>([\s\S]*)<\/mxlibrary>/);
  if (!match) {
    console.error("Failed to parse <mxlibrary> tag");
    process.exit(1);
  }

  const items: LibraryEntry[] = JSON.parse(match[1]);
  console.log(`Parsed ${items.length} library entries`);

  const catalog: CatalogEntry[] = [];
  const shapes: Record<string, ShapeEntry> = {};
  const slugCounts = new Map<string, number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.title) {
      console.log(`  Skipping index ${i} (no title)`);
      continue;
    }

    // Normalize title (fix &nbsp; and &amp;nbsp;)
    const title = item.title.replace(/&amp;nbsp;/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const parts = title.split(" - ");
    const category = normalizeCategory(parts[0]);
    const name = parts.slice(1).join(" - ").trim();

    // Generate unique slug
    let slug = toSlug(title);
    const count = slugCounts.get(slug) || 0;
    slugCounts.set(slug, count + 1);
    if (count > 0) {
      slug = `${slug}_${count}`;
    }

    catalog.push({
      id: i,
      slug,
      title,
      category,
      name,
      w: Math.round(item.w),
      h: Math.round(item.h),
    });

    shapes[String(i)] = {
      xml: item.xml,
      w: Math.round(item.w),
      h: Math.round(item.h),
      title,
    };
  }

  // Write catalog
  const catalogPath = path.join(dataDir, "oci-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`Wrote ${catalog.length} entries to ${catalogPath}`);

  // Write shapes
  const shapesPath = path.join(dataDir, "oci-shapes.json");
  fs.writeFileSync(shapesPath, JSON.stringify(shapes));
  console.log(`Wrote ${Object.keys(shapes).length} shapes to ${shapesPath}`);

  // Summary
  const cats = new Map<string, number>();
  for (const entry of catalog) {
    cats.set(entry.category, (cats.get(entry.category) || 0) + 1);
  }
  console.log(`\nCategories (${cats.size}):`);
  for (const [cat, count] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
}

main();
