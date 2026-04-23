# OCI Architecture Diagram Toolkit — Style Guide

Distilled from the official Oracle **OCI_Icons.pptx** (48 slides, v2024).

---

## Redwood Color Palette

| Name | Hex | RGB | Role |
|------|-----|-----|------|
| **Bark** | `#312D2A` | 49/45/42 | Text, connectors, dark borders |
| **Air** | `#FCFBFA` | 252/251/250 | Light backgrounds, component fills |
| **Neutral 1** | `#F5F4F2` | 245/244/242 | Region fill, location group fill |
| **Neutral 2** | `#DFDCD8` | 223/220/216 | Availability Domain fill |
| **Neutral 3** | `#9E9892` | 158/152/146 | Region/AD/FD borders, Tenancy border |
| **Neutral 4** | `#70736E` | 112/115/110 | Annotation badges |
| **Sienna** | `#AE562C` | 174/86/44 | VCN/Subnet/Compartment borders, icon accent |
| **O-Red** | `#C74634` | 199/70/52 | On-Premises component borders |
| **Ivy** | `#759C6C` | 117/156/108 | OCI component borders (logical) |
| **Ocean** | `#2C5967` | 44/89/103 | Icon alternate accent color |
| **Rose** | `#A36472` | 163/100/114 | Optional/Metro indicators |

> Icons may ONLY use **Sienna** or **Ocean** as accent colors. Never other colors.

---

## Two Diagram Types

### Logical Diagrams

> "A logical architecture diagram shows how a solution works by depicting logical components or capabilities. It gives an easier to understand, high-level abstraction."

- Shows **conceptual** architecture — service categories, data flows, integration points
- **No** physical assets, instances, or networking details
- Uses **Grouping** shapes (location + other) and **Component** boxes
- Flat or shallow nesting

### Physical Diagrams

> "Describes a solution that uses physical or virtualized components or products... does not usually abstract technical components into a single box."

- Shows **actual OCI infrastructure** — specific products, network topology
- Uses **Grouping** shapes (location + network + other) with deep nesting
- Uses product **icon** shapes (not component boxes)

---

## Logical Diagram Elements

### Location Groups (Slide 7)

| Group | Fill | Stroke | Stroke Style | Font | Shape |
|-------|------|--------|-------------|------|-------|
| Oracle Cloud | Neutral 1 `#F5F4F2` | Neutral 3 `#9E9892` | 1pt solid | 9pt Bold, Bark | roundRect |
| On-Premises | Neutral 1 `#F5F4F2` | Neutral 3 `#9E9892` | 1pt solid | 9pt Bold, Bark | roundRect |
| Internet | Neutral 1 `#F5F4F2` | Neutral 3 `#9E9892` | 1pt solid | 9pt Bold, Bark | roundRect |
| 3rd Party Cloud | Neutral 1 `#F5F4F2` | Neutral 3 `#9E9892` | 1pt solid | 9pt Bold, Bark | roundRect |

### Other Groups (Slide 7)

| Group | Fill | Stroke | Stroke Style | Font | Shape |
|-------|------|--------|-------------|------|-------|
| Other Group | Air `#FCFBFA` (none) | Bark `#312D2A` | 1pt dashed | 9pt Bold, Bark | rect |

### Component Boxes (Slide 8) — THE GREEN BOXES

| Component Type | Fill | Stroke Color | Stroke Style | Font |
|---------------|------|-------------|-------------|------|
| **OCI Component** | Air `#FCFBFA` | **Ivy `#759C6C`** | 1pt solid | 9pt Reg, Bark |
| **On-Premises / Oracle Component** | Air `#FCFBFA` | **O-Red `#C74634`** | 1pt solid | 9pt Reg, Bark |
| **3rd Party (non-OCI)** | Air `#FCFBFA` | **Bark `#312D2A`** | 1pt solid | 9pt Reg, Bark |
| **Atomic** (solid fill) | **Ivy `#759C6C`** | none | none | 9pt Reg, Air (white text) |
| **Collapsed Composite** | Air `#FCFBFA` | Ivy `#759C6C` | 1pt solid | 9pt Reg, Bark |
| **Expanded Composite** | Air `#FCFBFA` | Ivy `#759C6C` | 1pt dashed | 9pt Bold (title), Bark |

> **Key insight**: "Cajas verdes" = OCI Component boxes with Ivy green borders.
> These are NOT in the draw.io shape library — they must be generated as styled rectangles.

### Drill-Down (Slide 9)

- Use **Ivy at 50% transparency** to show expansion between Composite and Expanded views
- Collapsed Composite ➜ Expanded Composite progression

---

## Physical Diagram Elements

### Location Groups (Slide 18)

| Group | Fill | Stroke | Stroke Style | Align | Font | Shape |
|-------|------|--------|-------------|-------|------|-------|
| **OCI Region** | Neutral 1 `#F5F4F2` | Neutral 3 `#9E9892` | 1pt solid | Top/Center | 9pt Bold, Bark | roundRect |
| **Availability Domain** | Neutral 2 `#DFDCD8` | Neutral 3 `#9E9892` | 1pt solid | Top/Center | 9pt Semi-Bold, Bark | roundRect |
| **Fault Domain** | Air `#FCFBFA` | Neutral 3 `#9E9892` | 1pt solid | Top/Center | 9pt Semi-Bold, Bark | roundRect |

### Network Groups (Slide 18)

| Group | Fill | Stroke | Stroke Style | Align | Font | Shape |
|-------|------|--------|-------------|-------|------|-------|
| **Tenancy** | none | Neutral 3 `#9E9892` | 1pt dashed | Top/Left | 9pt Reg, Bark | rect |
| **Compartment** | none | Sienna `#AE562C` | 1pt sysDash | Top/Left | 9pt Bold, Sienna | rect |
| **VCN** | none | Sienna `#BB501C` | **1.25pt** dashed | Top/Left | 9pt Bold, Sienna | rect |
| **Subnet** | none | Sienna `#BB501C` | 1pt dashed | Top/Left | 9pt Bold, Sienna; 9pt Light, Bark (CIDR) | rect |

> VCN uses **1.25pt** stroke (thicker than others). All use **square corners** (rect, not roundRect).
> VCN/Subnet icons used at half-size as labels — can be omitted in complex diagrams.

### Other Physical Groups (Slides 18-19)

| Group | Fill | Stroke | Stroke Style | Font | Shape |
|-------|------|--------|-------------|------|-------|
| **User Group** | Neutral 1 `#F5F4F2` | Neutral 3 `#9E9892` | 1pt solid | 9pt, Bark | roundRect |
| **Tier** | none | Neutral 3 `#9E9892` | 1pt sysDot | 9pt, Bark | rect |
| **Metro Area/Realm** | Neutral 2 `#DFDCD8` | Neutral 3 `#9E9892` | 1pt solid | 9pt Extra-Bold, Bark | roundRect |
| **Oracle Services Network** | — | — | — | — | (freeform shape) |
| **Optional** indicator | Air `#FCFBFA` | Rose `#A36472` | 1pt dashed | 9pt, Rose | rect |

---

## Connectors

### Logical Connectors (Slide 10)

| Type | Line Style | Color | Weight | Arrowhead | Use |
|------|-----------|-------|--------|-----------|-----|
| **Dataflow** | Solid | Bark `#312D2A` | 1pt | Open | Data movement |
| **User Interaction** | Dashed | Bark `#312D2A` | 1pt | Open | User actions |

### Physical Connectors (Slide 20)

Same as logical — Bark color, 1pt, open arrowhead. Physical diagrams use **solid-line only** (no dataflow/user distinction).

### Special Connectors (Slides 21-22)

| Type | Icon | Label | Usage |
|------|------|-------|-------|
| **Local Peering** | none (text only) | "Local Peering" | Between LPGs, same region (1:1) |
| **Remote Peering** | Remote Peering icon (half size) | "Remote Peering" | Between DRGs, different regions |
| **Site-to-Site VPN** | VPN icon (half size) | "Site-to-Site VPN" | DRG to CPE device |
| **FastConnect** | FastConnect icon (half size) | "FastConnect" | DRG to on-premises/CPE |

> All special connector icons: **half size**, centered on the line, with Bark color.
> Label text: 8pt, Bark, on horizontal portion, Air background fill to mask line.
> For simple diagrams, Site-to-Site VPN and FastConnect may use text-only label (no icon).

---

## Connector Labels (Slide 11)

- 8pt font, Bark color
- Place on **horizontal** portions of the line
- Center on the connector line
- Use **Air `#FCFBFA` background fill** to mask the line behind text
- **Ordered annotations**: numbered circles (fill Neutral 4 `#70736E`, white text, 1.5pt stroke)
- **Unordered annotations**: lettered squares (same style)

---

## Icon Rules (Slide 23)

1. **Maintain aspect ratio** — always shift+scale
2. Only use **Sienna** (`#AE562C`) or **Ocean** (`#2C5967`) for icon accent colors
3. **Never**: rotate, flip, skew, embellish, add effects (drop-shadow, 3D, glow)
4. **Never** use unapproved colors or more than one color per icon
5. **Always** include identification labels
6. VCN/Subnet grouping icons: use at **half size** as container decorations

---

## Nesting Hierarchy

### Physical (deep nesting)
```
Region (Neutral 1 fill, Neutral 3 solid)
  └─ Availability Domain (Neutral 2 fill, Neutral 3 solid)  [optional]
      └─ Compartment (no fill, Sienna sysDash)
          └─ VCN (no fill, Sienna 1.25pt dashed)
              ├─ Public Subnet (no fill, Sienna 1pt dashed)
              └─ Private Subnet (no fill, Sienna 1pt dashed)
```

### Logical (flat)
```
Oracle Cloud (Neutral 1 fill, Neutral 3 solid)     On-Premises (same)
  ├─ [OCI Component] (Air fill, Ivy solid)            ├─ [Oracle Component] (Air, O-Red solid)
  ├─ [OCI Component]                                   └─ [Oracle Component]
  └─ Other Group (Air fill, Bark dashed)
       ├─ [OCI Component]
       └─ [3rd Party Component] (Air, Bark solid)

Internet (Neutral 1 fill, Neutral 3 solid)          3rd Party Cloud (same)
  └─ [3rd Party Component] (Air, Bark solid)           └─ [3rd Party Component]
```

---

## What the Draw.io Library Contains vs What Must Be Generated

### In the library (use as-is):
- All **icon** shapes (Compute, Networking, Database, etc.)
- **Physical grouping** shapes (Region, Compartment, VCN, Subnet, AD, FD, Tenancy)
- **Logical grouping** shapes (Oracle Cloud, On-Premises, Internet, 3rd Party, Other Group)
- Physical/Logical **connector** shapes
- Special connector shapes (FastConnect, VPN, Remote Peering)

### NOT in the library (must be generated as styled rectangles):
- **OCI Component boxes** (Ivy green border, roundRect)
- **On-Premises Component boxes** (O-Red border, roundRect)
- **3rd Party Component boxes** (Bark border, roundRect)
- **Atomic component boxes** (solid Ivy fill, roundRect)
- **Expanded Composite containers** (Ivy dashed border, roundRect)
