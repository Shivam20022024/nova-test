---
name: NovaTest AI
description: Autonomous QA platform — editorial-serif confidence over a dense, evidence-driven product.
colors:
  accent: "#2853ff"
  accent-soft: "#dbe6ff"
  accent-deep: "#17307a"
  accent-ink: "#eef2ff"
  ink: "#15121e"
  ink-soft: "#4a4558"
  muted: "#6d6780"
  paper: "#f7f4ee"
  paper-alt: "#ffffff"
  line: "#e6e1d6"
  sand: "#ede6d8"
  pass: "#178a4c"
  fail: "#d43d3d"
  running: "#2563eb"
  flaky: "#b3760f"
  healing: "#7c3aed"
  blocked: "#6b7280"
typography:
  display:
    fontFamily: "Besley, ui-serif, Georgia, 'Times New Roman', serif"
    fontSize: "clamp(2.25rem, 4vw + 1rem, 4.5rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Besley, ui-serif, Georgia, 'Times New Roman', serif"
    fontSize: "clamp(1.75rem, 2vw + 1.25rem, 3rem)"
    fontWeight: 400
    lineHeight: 1.2
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.05em"
rounded:
  sm: "0.375rem"
  md: "0.75rem"
  card: "1.75rem"
  full: "9999px"
spacing:
  xs: "0.5rem"
  sm: "1rem"
  md: "1.5rem"
  lg: "2.5rem"
  xl: "4rem"
  2xl: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.ink-soft}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0.75rem 1.25rem"
  button-outline-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  card:
    backgroundColor: "{colors.paper-alt}"
    rounded: "{rounded.card}"
  badge-confidence:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.full}"
    padding: "0.25rem 0.75rem"
---

# Design System: NovaTest AI

## Overview

**Creative North Star: "The Chain of Evidence"**

NovaTest AI's landing page reads like a precise report, not a pitch deck: a large editorial serif states the claim, monospace confirms it with a number, and one deliberate blue marks the moments that matter. The system is built around a single tension the product itself embodies — testing generates noise, evidence resolves it — so the visual language stays quiet everywhere except where a decision is actually being made (a confidence score, a passing trend, a call to act).

The base is warm and paper-like rather than clinical white, with a floating, deeply-shadowed product card doing the work of proving the claim rather than illustrating it. A faint grain texture marks the two moments the page changes register (the "Built for confidence" band and the closing footer), giving those transitions a tactile, printed quality instead of a flat color swap. Photography is abstract and duotone (accent-tinted gradient + grain) rather than literal, since no real product photography exists yet — this keeps the "evidence" feeling intentional rather than stock. The footer deepens from `accent` into `accent-deep` into `ink` top to bottom, so the closing wordmark sits in true midnight blue rather than flat brand-blue — the one place on the page night actually falls.

Content below the hero arrives as you scroll: each section and card fades up from `opacity:0`/`translateY` into place the first time it enters the viewport, once, never repeating. It is deliberately restrained (no parallax, no pinning, no hijacked scroll) — evidence accumulates as you read, it doesn't perform for you.

This is the Persuade surface only. The Operate surface (`/app/*`) inherits every token here but drops the serif display scale, the floating-card overlap technique, the grain texture, and the scroll-reveal motion — see Do's and Don'ts. A third surface, Document, is reserved for print-native artifacts generated from product data (starting with the Execution report at `/app/execution/:id/report`) — see Document Mode below.

**Key Characteristics:**
- One confident accent (`#2853ff`), never doubled with a second competing hue.
- Serif for every claim and number that matters; monospace for every label and unit; sans for chrome.
- Shadows exist only on things that are literally floating above the page.
- Grain is a punctuation mark, used at exactly two register changes, never as ambient texture.
- Content fades up into place on first scroll into view, once per element, never looping.

## Colors

A warm, near-monochrome neutral base (off-white paper, near-black ink) with exactly one saturated accent, plus a separate, deliberately unrelated status system reserved for product state.

### Primary
- **Confident Blue** (`#2853ff` / `accent`): the only saturated color on the page. Used for the hero gradient's most concentrated point, the "High Confidence" badge fill, the chart's single highlighted bar and its value pill, the closing-CTA gradient blob, and the top edge of the footer's gradient (see Footer in Components). Never used for body text or as a border on neutral surfaces.
- **Confident Blue, Soft** (`#dbe6ff` / `accent-soft`): the tint version — the hero gradient's base wash, the confidence metric tile's fill, and icon-chip backgrounds in the "Built for confidence" cards.
- **Confident Blue, Deep** (`#17307a` / `accent-deep`): reserved for content that sits *on* `accent-soft` and needs to read as ink, not accent (icon glyphs inside the tinted chips).
- **Confident Blue, Ink** (`#eef2ff` / `accent-ink`): the only color permitted as text/icon color on top of the solid `accent` fill (badges, chart pill, footer text and wordmark).

### Neutral
- **Ink** (`#15121e`): primary text and the fill for solid buttons.
- **Ink Soft** (`#4a4558`): secondary text on light and mid-tone surfaces (subheads, card body copy).
- **Muted** (`#6d6780`): tertiary text — small mono labels, metadata, captions.
- **Paper** (`#f7f4ee`): the page background everywhere outside the accent footer.
- **Paper Alt** (`#ffffff`): elevated surfaces — cards, modals, the floating product preview.
- **Line** (`#e6e1d6`): borders and dividers on paper.
- **Sand** (`#ede6d8`): the one alternate section background, used solely for the "Built for confidence" band to mark a register change without leaving the neutral family.

### Status System (semantic, not brand)
A fixed, product-wide vocabulary for test/execution state — deliberately unrelated to the brand accent so the two systems never compete for attention.
- **Pass** (`#178a4c`): passing tests, positive deltas (the `↓12.4%` runtime improvement, `98%` pass rate on the landing page preview).
- **Fail** (`#d43d3d`): failing tests, blocking errors.
- **Running** (`#2563eb`): in-progress executions. Deliberately a different, cooler blue than the brand accent (`#2853ff`) so status state and brand emphasis never read as the same signal.
- **Flaky** (`#b3760f`): intermittent/flaky tests.
- **Healing** (`#7c3aed`): AutoHeal in progress.
- **Blocked** (`#6b7280`): blocked or skipped.
Only Pass and Running appear on the landing page today (the preview card's deltas); the rest are defined and reserved for the Operate surface's DataTable/StatusBadge components.

### Named Rules
**The One Accent Rule.** `accent` appears in exactly one register per screen — a single hero, a single highlighted data point, a single CTA moment. If a second saturated color shows up anywhere outside the Status System, it's a bug, not a variant.

## Typography

**Display Font:** Besley (with ui-serif, Georgia, "Times New Roman", serif)
**Body Font:** Archivo (with ui-sans-serif, system-ui, -apple-system, sans-serif)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SFMono-Regular, Menlo, monospace)

**Character:** A confident transitional serif (Besley) for anything the page wants you to believe, paired with a technical monospace for anything the page wants you to verify — the same split as a report's headline versus its footnotes. Archivo carries everything in between (chrome, body copy, nav) without competing with either.

### Hierarchy
- **Display** (400, `clamp(2.25rem, 4vw + 1rem, 4.5rem)`, 1.05): hero headline only. Two lines max, set in Besley.
- **Headline** (400, `clamp(1.75rem, 2vw + 1.25rem, 3rem)`, 1.2): section headings ("Everything you need...", "Built for confidence"), card/quote headlines, always Besley.
- **Body** (400, 1rem–1.25rem, 1.6): paragraph copy, set in Besley when it's a claim (hero subtext, quote body, section descriptions) or Archivo when it's UI/chrome (nav links, card meta).
- **Label** (500, 0.75rem, letter-spacing 0.05em, uppercase): eyebrows, metric labels, button text, chart axis ticks — always JetBrains Mono, always uppercase-tracked.

### Named Rules
**The Serif-Announces, Mono-Confirms Rule.** Serif is for the claim (headlines, quotes, the big number on a metric tile). Mono is for the proof (the unit, the delta, the label, the button). The two never trade roles — a mono headline or a serif button label would break the system.

## Layout

A single centered column (`max-w-4xl` for hero text, `max-w-5xl` for the floating card, `max-w-6xl` for standard sections), generous section rhythm (`py-24`, 6rem top and bottom per section), and one repeated structural move: a `paper-alt` panel pulled upward with a negative margin (`-mt-20` mobile / `-mt-28` desktop) so it floats across the boundary between two backgrounds. That negative-margin overlap is reserved for exactly one panel per page (the product preview under the hero) — the amount of headroom left below the triggering content must equal or exceed the pull, so the float lands on empty background, never on text or a control.

Two-column sections (feature list, case study) split roughly 5:7 to 1:1 depending on content weight, image on one side, copy on the other, never symmetric 50/50 grids purely for symmetry's sake. Card grids use `gap-6` on 3-column layouts (`sm:grid-cols-3` / `md:grid-cols-3`), collapsing to a single column below `md` (768px). Standard Tailwind breakpoints throughout (`sm` 640 / `md` 768 / `lg` 1024).

## Elevation & Depth

Flat by default. The page has exactly one class of surface that lifts: things that are literally floating above the base layer (the product-preview card, the feature-list image's overlapping mini-stat card, modals). Everything else — section backgrounds, footer, three-card grid — stays flush with no shadow, differentiated by background color and the grain texture instead.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 40px 70px -30px rgba(21,18,30,0.35), 0 12px 24px -12px rgba(21,18,30,0.18)`): the only shadow token in the system. Large, soft, warm-tinted to the ink color (never pure black). Used on the product preview card, modals, and any panel that overlaps a section boundary.

### Named Rules
**The Float Rule.** Shadow means "this is physically above the page," never "this is important." A card that isn't overlapping or floating gets a border (`line`) or a background-color change instead, not a shadow.

## Shapes

Corner radius scales with a surface's prominence, not its size: the more attention a surface commands, the softer and larger its corner.
- **Buttons and small controls** (`0.375rem` / `rounded-sm`): the tightest radius, reserved for the most frequent, least prominent elements.
- **Tiles and mini-cards** (`0.75rem` / `rounded-md`): metric tiles inside the preview card, the overlapping stat card on the feature image.
- **Panels and cards** (`1.75rem` / `rounded-card`): the product preview card, feature cards, journal cards, modals, the duotone photo panels — anything that reads as its own surface.
- **Pills and glyphs** (`9999px` / `rounded-full`): badges, the confidence pill, icon chips.

### Named Rules
**The Radius-by-Weight Rule.** A button never gets `rounded-card`, and a hero-level panel never gets `rounded-sm`. If two elements share a radius, they should read as the same tier of visual weight.

## Components

### Buttons
- **Shape:** `rounded-sm` (6px) — the one deliberately tight radius on the page, so buttons never compete visually with cards.
- **Primary (solid):** `ink` background, `paper` text, `px-5 py-3`, `font-mono text-sm`, prefixed with a small square marker (▪) except when the label already ends in an arrow (nav's "Get started →").
- **Hover:** background shifts to `ink-soft`; no shadow, no scale change.
- **Outline (secondary):** transparent fill, `ink`-colored 1px border and text; on hover, fills solid to `ink` background / `paper` text — the outline button becomes the primary button on hover rather than gaining a tint.

### Cards / Containers
- **Corner Style:** `rounded-card` (28px).
- **Background:** `paper-alt` (white) on the `paper` page background; `paper-alt` again on the `sand` band for the three built-for cards.
- **Shadow Strategy:** `Float` shadow only when the card is overlapping a section boundary (product preview) or floating above content (modal). Feature/journal cards on flat ground use no shadow, `border border-line` instead where separation is needed.
- **Internal Padding:** `p-6` to `p-10` depending on card size (compact journal cards at `p-7`, the product preview at `p-6` mobile / `p-10` desktop).

### Badges
- **Confidence/status pill:** `rounded-full`, `accent` background, `accent-ink` text, `px-3 py-1`, `font-mono text-xs`. The only place `accent` is used as a fill behind text rather than as a line/gradient.

### Inputs / Fields
- **Style:** `rounded-md` (12px), `line`-colored 1px border, `paper-alt` background, label in `font-sans text-sm font-medium` sitting above the field (never a placeholder-as-label).
- **Focus:** border shifts to `accent`, no glow/ring — the same restraint as the rest of the system.
- **Error:** border and helper text shift to `fail`; helper text always renders below the field, replacing the neutral helper copy rather than stacking both.

### Navigation
- **Style:** sticky top bar, `bg-paper/90` with `backdrop-blur`, `border-b border-line`, 1-line at desktop, collapses to a hamburger + slide-down panel below `md` (768px).
- **Logo:** `font-sans font-bold text-xl`, `ink` — the one place Archivo is set bold at display size.
- **Links:** `text-sm`, `ink-soft` default, `ink` on hover, no underline.
- **CTA:** always the primary solid button, right-aligned.

### Duotone Panel (signature component)
A CSS-only stand-in for photography, used everywhere the design calls for duotone imagery but no real photo exists yet: a rotated multi-stop radial gradient (`accent-soft` → `accent` → near-black) clipped to the container, overlaid with the same grain texture at low opacity and `mix-blend-mode: overlay`. Each usage passes a different rotation seed so instances don't look identical. This is documented as a deliberate placeholder system, not a permanent art direction — it should be the first thing replaced once real product/lifestyle photography exists.

### Footer
- **Background:** a vertical gradient, not a flat fill — `linear-gradient(180deg, accent 0%, accent-deep 55%, ink 100%)`. The link columns sit in the vivid-blue zone; the giant closing wordmark sits in the near-black zone at the bottom. This is the one surface on the page that's allowed to go all the way to `ink`-dark, because it's leaving the reader, not asking them to read.
- **Text:** `accent-ink` at full opacity throughout (headers via `font-mono uppercase`, links via `font-sans`) — hierarchy comes from typography, not from dimming opacity, because opacity-dimmed text against this particular gradient drops below WCAG AA (measured ~2.7:1 at 60% opacity against the `accent` zone).
- **Texture:** `bg-grain`, same treatment as "Built for confidence."

### Scroll Reveal (signature motion)
Every section from the feature list onward (never the hero) fades up into place the first time it crosses into the viewport: `opacity 0→1` + `translateY(48-64px)→0`, ~700ms, `cubic-bezier(0.16,1,0.3,1)`, via `IntersectionObserver` (not a scroll listener). Cards in a row (feature list items, the three "Built for confidence" cards, journal cards) stagger by ~90-100ms per item. It fires once and disconnects — no re-triggering on scroll-back-up, no looping, no parallax, no pinning. Falls back to fully visible with no animation under `prefers-reduced-motion: reduce`.

## Document Mode

A third surface alongside Persuade (marketing) and Operate (dashboard): print-native reports generated from product data — evidence an engineering leader reads once, trusts, and may print or file. It inherits every token above but recomposes them toward the vernacular of a formal report rather than a dashboard panel or a hero page.

**The Verdict Masthead (signature component).** Where Operate would show a status in a tinted dashboard card, Document sets the verdict itself as a headline: the decision word (`Blocked` / `Approved with Risk` / `Approved`) in Besley serif at `text-4xl`–`text-5xl`, colored by the status system, inside a plain `border-y border-line` block with no background tint and no side border. The color lives in the word; the frame around it stays neutral. This is the one place per document that spends color — everything else stays ink-on-paper.

**Layout.** A single `max-w-4xl` column (narrower than Operate's `max-w-[1400px]`) framed in a bordered, un-rounded `paper-alt` panel that floats on the surrounding Operate chrome's `paper` background — a page, not a panel. Generous padding (`p-8` mobile up to `p-16` desktop). No `shadow-float` — the Float Rule reserves shadow for things literally overlapping a boundary; a report page sits flush, framed by its border alone, the same logic that already keeps flat feature/journal cards on the marketing page shadow-free.

**Radius.** The page frame itself is square — no radius. Printed pages don't have rounded corners, and that's the signature cue that this is a page, not a card; a deliberate departure from Persuade's `rounded-card`. Small functional elements *inside* the page — score tiles, table containers, the risk heatmap's cells — keep Operate's own `rounded-sm` tier rather than also going square. Zeroing those too would make Document mode look like a different product instead of the same one in a different mode; the un-rounded treatment is reserved for the one element that's actually standing in for a printed page.

**Section structure — running folios.** Each numbered section opens with a folio line (`§ 01 / 10`, JetBrains Mono) and a Besley serif heading, separated from the previous section by a single hairline (`border-t border-line`), and closes with a running footer: a hairline rule, the mandatory confidentiality line, and the folio repeated right-aligned. This is a real page-numbering convention, not decoration — the numbers encode where the reader is in a genuinely sequential document.

**Typography.** Serif-Announces, Mono-Confirms applies exactly as elsewhere: the verdict, report title, and section headings are Besley; every score, timestamp, run ID, table header, and status label is JetBrains Mono; body prose is Archivo.

**Print behavior.** Document-mode pages render inside the normal Operate shell on screen (so navigation stays available) but declare `print:hidden` on the Sidebar, Topbar, ContextHeader, Copilot launcher, and the Operate gradient/grain wash, and `print:max-w-none print:border-0 print:p-0` on the page frame itself, so a physical printout uses the full page instead of a narrow floating column. The shell's root background switches to `paper-alt` under print so the printed page is clean white, not tinted.

### Do:
- **Do** reuse every color, radius, and type token from this document — Document mode is a recomposition, never a new palette.
- **Do** keep the verdict as the single colored moment per report; every status pill/table cell elsewhere uses the existing Status System at normal weight.

### Don't:
- **Don't** use a tinted background or a side (`border-l-4`) accent border to show status — both read as generic AI-dashboard exports, not a report. Color the headline word itself instead.
- **Don't** apply the marketing page's Scroll Reveal motion here — a report must render fully and immediately, both for reading under time pressure and for reliable printing.

## Do's and Don'ts

### Do:
- **Do** keep `accent` to one register per screen (Named Rule: The One Accent Rule).
- **Do** set every headline, quote, and "big number" in Besley; every label, unit, and button in JetBrains Mono.
- **Do** use the `Float` shadow only on genuinely overlapping/floating surfaces.
- **Do** carry these exact tokens into `/app/*` — same accent, same status colors, same radius/shadow scale.
- **Do**, on `/app/*`, confine `accent` to targeted moments only (topbar wash, primary buttons, the Command Center confidence ring, empty-state banners) — never as a dashboard page background.
- **Do** use the Scroll Reveal pattern for below-the-fold section entrances on the marketing page — it's the one motion signature this page has, applied consistently rather than one-off.

### Don't:
- **Don't** introduce a second saturated accent color anywhere (no purple, no secondary brand hue) — this is a binding brand commitment, not just a page-level choice.
- **Don't** use the grain texture as ambient decoration; it marks a register change and appears in at most two places per page.
- **Don't** repaint `/app/*` surfaces with the marketing hero's full-bleed gradient — sidebar, tables, and cards stay neutral, colored only via the Status System and targeted accent moments.
- **Don't** use `rounded-card` on a button or `rounded-sm` on a hero-level panel — radius signals weight, and mixing tiers reads as unintentional.
- **Don't** apply the `Float` shadow to a flat, non-overlapping surface just to add depth.
- **Don't** apply Scroll Reveal to the hero (it's already the first thing seen) or to `/app/*` (Operate mode renders instantly, no entrance choreography).
- **Don't** dim badge/label hierarchy with opacity on a colored background without checking contrast — use a different color or typographic weight instead (see Footer).
