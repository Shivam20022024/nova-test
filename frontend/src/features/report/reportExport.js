/**
 * reportExport.js
 * Multi-format export engine for NovaTest AI Test Intelligence Report.
 * Supports HTML, Executive PDF, JSON, and ZIP bundle.
 */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import JSZip from "jszip";
import novalantisLogoUrl from "../../assets/novalantis-logo.jpg";
import { PDF_COLORS, PDF_MARGIN, pdfDecisionPalette as sharedDecisionPalette } from "./pdfDesignSystem";

/**
 * Downloads a text/blob file in browser.
 */
function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Fetches the bundled Novalantis logo and converts it to a base64 data URL
 * once per session (jsPDF's addImage needs a data URL, not a bare asset
 * path). Cached so repeated exports don't refetch/re-encode it.
 */
let cachedLogoDataUrl = null;
async function getNovalantisLogoDataUrl() {
  if (cachedLogoDataUrl) return cachedLogoDataUrl;
  try {
    const res = await fetch(novalantisLogoUrl);
    const blob = await res.blob();
    cachedLogoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return cachedLogoDataUrl;
  } catch (err) {
    console.warn("Failed to load Novalantis logo for PDF export:", err);
    return null;
  }
}

/**
 * Fetches an arbitrary (screenshot) URL and converts it to a base64 data URL so
 * jsPDF's addImage can embed it. Returns null on any failure (CORS, 404,
 * network) so the caller can fall back to "image unavailable" - never throws,
 * never fabricates.
 */
async function fetchImageDataUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────
 * PDF design system - shared colors, geometry, and helpers
 * ──────────────────────────────────────────────────────────── */
// Moved to pdfDesignSystem.ts, which the mobile report's PDF export shares -
// kept the same local names here so nothing below this line had to change.
const PDF = { margin: PDF_MARGIN, colors: PDF_COLORS };
const pdfDecisionPalette = sharedDecisionPalette;

/**
 * Generates a professional, multi-section Executive PDF Report:
 * branded cover page with a dynamic table of contents, running
 * header/footer with page numbers, styled KPI cards, a full
 * execution timeline, and detailed narrative + tabular sections.
 *
 * Note: jsPDF's built-in Helvetica font only supports the WinAnsi
 * character set, which does NOT include ✓ / ✕ / ⚠ - those render
 * as garbage glyphs. Status is therefore always communicated via a
 * small filled circle (drawn as a vector shape) plus a plain-text,
 * color-coded label instead of relying on Unicode symbols.
 */
export async function generateReportPdf(report, options = { download: true }) {
  if (!report) return null;

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;
  const margin = PDF.margin;
  const contentWidth = pageWidth - margin * 2;
  const c = PDF.colors;
  let currentY = margin;
  let sectionCounter = 0;

  const setColor = (fn, rgb) => fn(rgb[0], rgb[1], rgb[2]);

  /* ── Page-break-aware cursor helpers ─────────────────────── */
  const ensureSpace = (needed) => {
    if (currentY + needed > pageHeight - 22) {
      doc.addPage();
      currentY = margin + 4;
    }
  };

  const statusDot = (x, y, color, r = 1.3) => {
    setColor(doc.setFillColor.bind(doc), color);
    doc.circle(x, y, r, "F");
  };

  const sectionTitle = (title, badge = null) => {
    sectionCounter += 1;
    ensureSpace(16);
    setColor(doc.setTextColor.bind(doc), c.brandIndigo);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(String(sectionCounter).padStart(2, "0"), margin, currentY);

    setColor(doc.setTextColor.bind(doc), c.ink);
    doc.setFontSize(13);
    doc.text(title, margin + 9, currentY);

    if (badge) {
      const titleWidth = doc.getTextWidth(title);
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      setColor(doc.setTextColor.bind(doc), c.brandIndigo);
      doc.text(badge.toUpperCase(), margin + 9 + titleWidth + 5, currentY - 0.3);
    }

    currentY += 3.5;
    setColor(doc.setDrawColor.bind(doc), c.hairline);
    doc.setLineWidth(0.4);
    doc.line(margin, currentY, margin + contentWidth, currentY);
    currentY += 7;
  };

  const bodyText = (text, opts = {}) => {
    const { size = 9, color = c.inkSoft, indent = 0, lineHeight = 4.2 } = opts;
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    setColor(doc.setTextColor.bind(doc), color);
    const lines = doc.splitTextToSize(text, contentWidth - indent);
    ensureSpace(lines.length * lineHeight + 2);
    doc.text(lines, margin + indent, currentY);
    currentY += lines.length * lineHeight;
    return lines.length * lineHeight;
  };

  /* ── KPI card grid (4-up) ─────────────────────────────────── */
  const kpiCardGrid = (items) => {
    const gap = 5;
    const cardW = (contentWidth - gap * 3) / 4;
    const cardH = 24;
    ensureSpace(cardH + 4);
    items.forEach((item, idx) => {
      const col = idx % 4;
      if (col === 0 && idx > 0) currentY += cardH + gap;
      const x = margin + col * (cardW + gap);
      setColor(doc.setFillColor.bind(doc), c.panelBg);
      setColor(doc.setDrawColor.bind(doc), c.hairline);
      doc.setLineWidth(0.3);
      doc.roundedRect(x, currentY, cardW, cardH, 2, 2, "FD");

      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.5);
      setColor(doc.setTextColor.bind(doc), c.inkMuted);
      doc.text(item.label.toUpperCase(), x + 4, currentY + 6);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      setColor(doc.setTextColor.bind(doc), item.color || c.ink);
      doc.text(String(item.value), x + 4, currentY + 16);

      if (item.sub) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6.5);
        setColor(doc.setTextColor.bind(doc), c.inkMuted);
        doc.text(item.sub, x + 4, currentY + 21);
      }
    });
    currentY += cardH + 8;
  };

  /* ── Precompute which optional sections will actually render,
   *    so the cover page's table of contents is accurate and the
   *    section numbering never skips (02 -> 05 style gaps). ──── */
  const hasTimeline = report.timeline && report.timeline.length > 0;
  const hasFailures = report.failures && report.failures.length > 0;
  const hasHealing = report.healing && report.healing.length > 0;
  const hasDeveloperActions = report.developerActions && report.developerActions.length > 0;
  const hasPageAnalysis = report.pageAnalysis && report.pageAnalysis.length > 0;
  const hasObservations = report.ai.observations && report.ai.observations.length > 0;
  const hasRecommendations = report.ai.recommendations && report.ai.recommendations.length > 0;
  const hasDetectedIssues = report.ai.detectedIssues && report.ai.detectedIssues.length > 0;
  const hasJira = !!report.metadata.jiraTicketId;
  const hasAiInsights = hasObservations || hasRecommendations || hasDetectedIssues;

  const tocEntries = [
    "AI Executive Summary",
    "Release Decision",
    "Test Execution Summary",
    hasFailures && "Failed Scenarios",
    hasDeveloperActions && "Developer Action Center",
    hasFailures && "Failure Details & Root Cause",
    hasHealing && "Self-Healing Results",
    "Accessibility",
    "Security Sanity Checks",
    hasPageAnalysis && "Page Validation Matrix",
    "Performance",
    "Screenshot / Evidence",
    hasJira && "Bug Tracking",
    hasAiInsights && "AI Insights",
    hasTimeline && "Raw Execution Timeline",
    "Technical Appendix",
  ].filter(Boolean);

  /* ══════════════════════════════════════════════════════════
   * COVER PAGE
   * ══════════════════════════════════════════════════════════ */
  const logoDataUrl = await getNovalantisLogoDataUrl();

  setColor(doc.setFillColor.bind(doc), c.ink);
  doc.rect(0, 0, pageWidth, 64, "F");

  // Brand mark - the actual Novalantis logo, on a white card since the
  // source JPG has an opaque white background (JPEGs can't be transparent).
  const logoW = 34;
  const logoH = 12.3; // preserves the source image's ~2.77:1 aspect ratio
  if (logoDataUrl) {
    setColor(doc.setFillColor.bind(doc), c.white);
    doc.roundedRect(margin, 15, logoW + 3, logoH + 3, 2, 2, "F");
    doc.addImage(logoDataUrl, "JPEG", margin + 1.5, 16.5, logoW, logoH);
  } else {
    // Fallback if the logo failed to load - keep the page from looking broken
    setColor(doc.setFillColor.bind(doc), c.brandIndigo);
    doc.roundedRect(margin, 16, 10, 10, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    setColor(doc.setTextColor.bind(doc), c.white);
    doc.text("N", margin + 3.2, 23.2);
  }

  const brandTextX = margin + logoW + 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  setColor(doc.setTextColor.bind(doc), c.white);
  doc.text("NovaTest AI", brandTextX, 21.5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text("ENTERPRISE QA PLATFORM", brandTextX, 26);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  setColor(doc.setTextColor.bind(doc), c.white);
  doc.text("Test Intelligence Report", margin, 46);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text(`Run #${report.metadata.runNumber} - Generated ${report.metadata.createdAtFormatted}`, margin, 54);

  currentY = 76;

  // Test identity card - height flexes with content instead of a fixed box
  const identityCardTop = currentY;
  let identityCursor = currentY + 9;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  const titleLines = doc.splitTextToSize(report.metadata.suiteName, contentWidth - 10).slice(0, 1);

  let descLines = [];
  if (report.metadata.testDescription) {
    doc.setFontSize(8.5);
    descLines = doc.splitTextToSize(report.metadata.testDescription, contentWidth - 10).slice(0, 2);
  }
  const identityCardH = 15 + (descLines.length ? descLines.length * 4 + 3 : 0) + 9;

  setColor(doc.setFillColor.bind(doc), c.panelBg);
  setColor(doc.setDrawColor.bind(doc), c.hairline);
  doc.roundedRect(margin, identityCardTop, contentWidth, identityCardH, 2, 2, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  setColor(doc.setTextColor.bind(doc), c.ink);
  doc.text(titleLines, margin + 5, identityCursor);
  identityCursor += 6;

  if (descLines.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    setColor(doc.setTextColor.bind(doc), c.inkSoft);
    doc.text(descLines, margin + 5, identityCursor);
    identityCursor += descLines.length * 4 + 3;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  setColor(doc.setTextColor.bind(doc), c.brandIndigo);
  const targetLine = report.metadata.targetUrl ? `Target: ${report.metadata.targetUrl}` : "Target: Not specified";
  doc.text(targetLine, margin + 5, identityCursor);

  currentY = identityCardTop + identityCardH + 8;

  // Release decision hero - height + text now flex to fit wrapped content
  const palette = pdfDecisionPalette(report.releaseDecision.decision);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  const decisionTitleLines = doc.splitTextToSize(`AI RELEASE DECISION: ${report.releaseDecision.title}`, contentWidth - 18);
  doc.setFontSize(8);
  const reasonsLines = doc.splitTextToSize(report.releaseDecision.reasons.join(" - "), contentWidth - 12).slice(0, 2);
  const heroH = 10 + decisionTitleLines.length * 6 + 6 + reasonsLines.length * 4 + 4;

  const heroTop = currentY;
  setColor(doc.setFillColor.bind(doc), palette.bg);
  setColor(doc.setDrawColor.bind(doc), palette.border);
  doc.setLineWidth(0.6);
  doc.roundedRect(margin, heroTop, contentWidth, heroH, 2, 2, "FD");

  statusDot(margin + 8, heroTop + 10, palette.accent, 2.2);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  setColor(doc.setTextColor.bind(doc), palette.text);
  doc.text(decisionTitleLines, margin + 14, heroTop + 10);
  let heroCursor = heroTop + 10 + decisionTitleLines.length * 6 + 2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setColor(doc.setTextColor.bind(doc), c.inkSoft);
  doc.text(
    `Health Score: ${report.releaseDecision.healthScore}/100 - Risk: ${report.releaseDecision.riskLevel} - AI Confidence: ${report.releaseDecision.confidence}% - Pass Rate: ${report.summary.passRate}%`,
    margin + 6,
    heroCursor
  );
  heroCursor += 6;

  doc.setFontSize(8);
  doc.text(reasonsLines, margin + 6, heroCursor);

  currentY = heroTop + heroH + 8;

  // Cover KPI strip
  kpiCardGrid([
    { label: "Total Tests", value: report.summary.totalTests, color: c.ink },
    { label: "Passed", value: report.summary.passedCount, color: c.emerald },
    { label: "Failed", value: report.summary.failedCount, color: report.summary.failedCount > 0 ? c.rose : c.ink },
    { label: "Duration", value: report.metadata.durationFormatted, color: c.ink },
  ]);

  // Cover run details (left column) + table of contents (right column)
  setColor(doc.setDrawColor.bind(doc), c.hairline);
  doc.setLineWidth(0.3);
  doc.line(margin, currentY, margin + contentWidth, currentY);
  currentY += 7;

  const colGap = 10;
  const colW = (contentWidth - colGap) / 2;
  const columnsTop = currentY;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text("RUN DETAILS", margin, columnsTop);

  const runDetailRows = [
    ["Browser Engine", (report.metadata.browser || "chromium").toUpperCase()],
    ["Started At", report.metadata.createdAtFormatted],
    ["Self-Healed Selectors", String(report.summary.selfHealedCount)],
    ["Accessibility (WCAG)", report.accessibility.status],
    ["Security Sanity", report.security.status],
    ["DOM Stability", String(report.summary.domStability)],
  ];
  // Rows can grow past a fixed spacing once optional sections push the TOC
  // past ~10 entries - shrink line pitch (never below 4mm) so it always
  // fits above the cover footer instead of overflowing the page.
  const maxRows = Math.max(runDetailRows.length, tocEntries.length);
  const availableRowsH = pageHeight - 24 - (columnsTop + 6);
  const rowStep = Math.max(4, Math.min(5.5, availableRowsH / maxRows));

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  runDetailRows.forEach(([label, value], idx) => {
    const rowY = columnsTop + 6 + idx * rowStep;
    setColor(doc.setTextColor.bind(doc), c.inkMuted);
    doc.text(label, margin, rowY);
    setColor(doc.setTextColor.bind(doc), c.ink);
    doc.setFont("helvetica", "bold");
    const valueLines = doc.splitTextToSize(String(value), colW - 40);
    doc.text(valueLines[0], margin + 40, rowY);
    doc.setFont("helvetica", "normal");
  });

  // Table of contents - fills out the cover page with a genuinely
  // useful index instead of leaving the bottom of the page blank.
  const tocX = margin + colW + colGap;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text("IN THIS REPORT", tocX, columnsTop);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  tocEntries.forEach((entry, idx) => {
    const rowY = columnsTop + 6 + idx * rowStep;
    setColor(doc.setTextColor.bind(doc), c.brandIndigo);
    doc.setFont("helvetica", "bold");
    doc.text(String(idx + 1).padStart(2, "0"), tocX, rowY);
    setColor(doc.setTextColor.bind(doc), c.ink);
    doc.setFont("helvetica", "normal");
    doc.text(entry, tocX + 8, rowY);
  });

  currentY = columnsTop + 6 + maxRows * rowStep;

  /* ══════════════════════════════════════════════════════════
   * CONTENT PAGES
   * ══════════════════════════════════════════════════════════ */
  doc.addPage();
  currentY = margin + 4;

  const scoreOf = (val) => (val === null || val === undefined ? null : Math.round(val));
  const scoreColor = (val) => (val === null ? c.inkMuted : val >= 80 ? c.emerald : val >= 50 ? c.amber : c.rose);
  const hBar = (label, value, total, color, y) => {
    const barW = contentWidth - 45;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    setColor(doc.setTextColor.bind(doc), c.inkSoft);
    doc.text(label, margin, y);
    setColor(doc.setTextColor.bind(doc), c.ink);
    doc.text(String(value), margin + contentWidth - 6, y, { align: "right" });
    setColor(doc.setFillColor.bind(doc), c.hairline);
    doc.roundedRect(margin, y + 1.5, barW, 2.6, 1.3, 1.3, "F");
    const pct = total > 0 ? Math.max(0.03, value / total) : 0;
    setColor(doc.setFillColor.bind(doc), color);
    if (pct > 0) doc.roundedRect(margin, y + 1.5, barW * pct, 2.6, 1.3, 1.3, "F");
  };
  const priorityColor = (p) => (p === "CRITICAL" ? c.rose : p === "HIGH" ? [249, 115, 22] : p === "MEDIUM" ? c.amber : c.emerald);
  const clip = (s, n) => { const v = String(s ?? ""); return v.length > n ? v.slice(0, n - 1) + "..." : v; };

  const s = report.summary;
  const ec = report.executionClassification || {};

  /* ── 1. AI EXECUTIVE SUMMARY ─────────────────────────────── */
  sectionTitle("AI Executive Summary", "Telemetry-Verified");
  bodyText(s.aiSummaryText || "No summary narrative was generated for this execution.");
  currentY += 2;
  bodyText(
    `Health Score: ${s.healthScore}/100 - Pass Rate (steps): ${s.passRate}% - Interaction Success: ${s.interactionSuccessRate}%`,
    { size: 8, color: c.inkMuted }
  );
  currentY += 4;

  /* ── 2. RELEASE DECISION ─────────────────────────────────── */
  sectionTitle("Release Decision", report.releaseDecision.riskLevel);
  {
    const palette2 = pdfDecisionPalette(report.releaseDecision.decision);
    ensureSpace(30);
    const boxTop = currentY;
    const reasons = (report.releaseDecision.reasons || []).filter(Boolean);
    doc.setFontSize(8);
    const wrappedReasons = reasons.flatMap((r) => doc.splitTextToSize(` - ${r}`, contentWidth - 12));
    const boxH = 20 + wrappedReasons.length * 4;
    setColor(doc.setFillColor.bind(doc), palette2.bg);
    setColor(doc.setDrawColor.bind(doc), palette2.border);
    doc.setLineWidth(0.5);
    doc.roundedRect(margin, boxTop, contentWidth, boxH, 2, 2, "FD");
    statusDot(margin + 6, boxTop + 8, palette2.accent, 2);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    setColor(doc.setTextColor.bind(doc), palette2.text);
    doc.text(report.releaseDecision.title, margin + 12, boxTop + 9);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    setColor(doc.setTextColor.bind(doc), c.inkSoft);
    doc.text(
      `Execution: ${ec.executionStatus || "COMPLETED"} - Failure Class: ${report.releaseDecision.failureClass || "n/a"} - Application Quality: ${report.releaseDecision.applicationQuality || "EVALUATED"}${report.releaseDecision.blockType ? ` - Block Type: ${report.releaseDecision.blockType}` : ""}`,
      margin + 6,
      boxTop + 15
    );
    let ry = boxTop + 20;
    wrappedReasons.forEach((ln) => { doc.text(ln, margin + 6, ry); ry += 4; });
    currentY = boxTop + boxH + 6;
  }
  bodyText(
    "APPLICATION FAILURE = the site behaved incorrectly.   TEST EXECUTION FAILURE = the automation (selector / timing / page state) is at fault.   INFRASTRUCTURE FAILURE = the runner could not run.   ANTI-BOT BLOCK = a challenge/WAF stopped the run.",
    { size: 7, color: c.inkMuted }
  );
  currentY += 4;

  /* ── 3. TEST EXECUTION SUMMARY ───────────────────────────── */
  sectionTitle("Test Execution Summary");
  kpiCardGrid([
    { label: "Scenarios", value: s.totalTests, color: c.ink, sub: `${s.passedCount} pass - ${s.failedCount} fail` },
    { label: "Executable Steps", value: s.totalSteps, color: c.ink, sub: `${s.passedSteps} pass - ${s.failedSteps} fail - ${s.skippedSteps || 0} skip` },
    { label: "Step Pass Rate", value: `${s.passRate}%`, color: scoreColor(s.passRate), sub: `${s.passedSteps}/${s.executableStepTotal || s.totalSteps} steps` },
    { label: "Self-Healed", value: report.healingSummary ? report.healingSummary.successes : s.selfHealedCount, color: c.brandCyan, sub: report.healingSummary ? `${report.healingSummary.successes}/${report.healingSummary.attempts} recovered` : "selectors recovered" },
  ]);

  ensureSpace(24);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text("SCENARIO OUTCOME", margin, currentY);
  currentY += 6;
  const scTotal = Math.max(1, s.passedCount + s.failedCount + s.skippedCount);
  hBar("Passed", s.passedCount, scTotal, c.emerald, currentY); currentY += 7;
  hBar("Failed", s.failedCount, scTotal, c.rose, currentY); currentY += 7;
  hBar("Skipped", s.skippedCount, scTotal, c.inkMuted, currentY); currentY += 7;
  if (s.partiallyPassedCount > 0) { hBar("Partially completed", s.partiallyPassedCount, scTotal, c.amber, currentY); currentY += 7; }
  currentY += 4;

  ensureSpace(24);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text("EXECUTABLE STEP OUTCOME", margin, currentY);
  currentY += 6;
  const stTotal = Math.max(1, s.totalSteps);
  hBar("Passed", s.passedSteps, stTotal, c.emerald, currentY); currentY += 7;
  hBar("Failed", s.failedSteps, stTotal, c.rose, currentY); currentY += 7;
  hBar("Skipped", s.skippedSteps || 0, stTotal, c.inkMuted, currentY); currentY += 11;

  // Scenario table
  const testRows = report.tests.map((t) => [
    t.status === "PASSED" ? "PASS" : t.status === "SKIPPED" ? "SKIP" : "FAIL",
    clip(t.name, 46),
    `${t.passedSteps || 0}/${t.totalSteps || 0}`,
    t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : "<1s",
    t.risk,
    t.healed ? "Yes" : "No",
    clip(t.error || "-", 40),
  ]);
  autoTable(doc, {
    startY: currentY,
    head: [["Status", "Scenario", "Steps P/T", "Duration", "Risk", "Healed", "Error"]],
    body: testRows,
    theme: "striped",
    margin: { left: margin, right: margin },
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: c.ink, textColor: c.white, fontStyle: "bold" },
    alternateRowStyles: { fillColor: c.panelBg },
    didParseCell: (data) => {
      if (data.column.index === 0 && data.section === "body") {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.textColor = data.cell.text[0] === "PASS" ? c.emerald : data.cell.text[0] === "SKIP" ? c.inkMuted : c.rose;
      }
    },
  });
  currentY = doc.lastAutoTable.finalY + 8;

  // Scenarios skipped because a prerequisite scenario failed (test-design issue)
  if (report.blockedScenarios && report.blockedScenarios.length > 0) {
    bodyText(`SKIPPED - PREREQUISITE FAILED (${report.blockedScenarios.length})`, { size: 8, color: c.amberDark, bold: true });
    currentY += 1;
    report.blockedScenarios.forEach((b) => {
      ensureSpace(6);
      statusDot(margin + 1.3, currentY - 1.3, c.amber, 1.1);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.6);
      setColor(doc.setTextColor.bind(doc), c.inkSoft);
      const lines = doc.splitTextToSize(`${b.scenario} - ${b.reason}`, contentWidth - 8);
      doc.text(lines, margin + 5, currentY);
      currentY += lines.length * 3.8;
    });
    bodyText("These are test-design / sequencing issues, not application defects - fix the failing prerequisite scenario first.", { size: 7, color: c.inkMuted });
    currentY += 4;
  }

  // Verified checks checklist
  if (s.validationResults && s.validationResults.length > 0) {
    bodyText(`VERIFIED CHECKS (${s.validationResults.length})`, { size: 8, color: c.inkMuted, bold: true });
    currentY += 1;
    s.validationResults.slice(0, 12).forEach((item) => {
      ensureSpace(5);
      statusDot(margin + 1.3, currentY - 1.3, c.emerald, 1.1);
      const lines = doc.splitTextToSize(String(item), contentWidth - 8);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      setColor(doc.setTextColor.bind(doc), c.inkSoft);
      doc.text(lines, margin + 5, currentY);
      currentY += lines.length * 4;
    });
    currentY += 4;
  }

  /* ── 4. FAILED SCENARIOS ─────────────────────────────────── */
  if (hasFailures) {
    sectionTitle("Failed Scenarios", `${report.failures.length}`);
    const failRows = report.failures.map((f) => [
      clip(f.scenario, 34),
      f.severity || "HIGH",
      f.failureCategory || (f.classification && f.classification.code) || "UNKNOWN",
      clip(f.page, 40),
      clip(f.failedElement, 34),
    ]);
    autoTable(doc, {
      startY: currentY,
      head: [["Scenario", "Severity", "Category", "Page", "Failed Element"]],
      body: failRows,
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 7.5, cellPadding: 2 },
      headStyles: { fillColor: c.rose, textColor: c.white },
      alternateRowStyles: { fillColor: c.roseBg },
      didParseCell: (data) => {
        if (data.column.index === 1 && data.section === "body") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = priorityColor(String(data.cell.text[0]));
        }
      },
    });
    currentY = doc.lastAutoTable.finalY + 8;
  }

  /* ── 5. DEVELOPER ACTION CENTER ──────────────────────────── */
  if (hasDeveloperActions) {
    sectionTitle("Developer Action Center", `${report.developerActions.length}`);
    report.developerActions.slice(0, 12).forEach((a, idx) => {
      ensureSpace(20);
      const top = currentY;
      const actLines = doc.splitTextToSize(a.recommendedAction || "-", contentWidth - 10);
      const probLines = doc.splitTextToSize(a.problem || "-", contentWidth - 10);
      const cardH = 13 + probLines.length * 3.6 + actLines.length * 3.6;
      setColor(doc.setFillColor.bind(doc), c.panelBg);
      setColor(doc.setDrawColor.bind(doc), c.hairline);
      doc.setLineWidth(0.3);
      doc.roundedRect(margin, top, contentWidth, cardH, 1.5, 1.5, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      setColor(doc.setTextColor.bind(doc), priorityColor(a.priority));
      doc.text(`${a.priority}`, margin + 3, top + 5.5);
      setColor(doc.setTextColor.bind(doc), c.ink);
      doc.text(clip(`${idx + 1}. ${a.scenario}`, 60), margin + 20, top + 5.5);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
      setColor(doc.setTextColor.bind(doc), c.inkMuted);
      doc.text(clip(`${a.page} - ${a.failedElement || "n/a"}`, 120), margin + 3, top + 9.5);
      setColor(doc.setTextColor.bind(doc), c.inkSoft);
      doc.setFontSize(7.2);
      let dy = top + 13;
      doc.text(probLines, margin + 3, dy); dy += probLines.length * 3.6;
      setColor(doc.setTextColor.bind(doc), c.brandIndigo);
      doc.text(actLines, margin + 3, dy);
      currentY = top + cardH + 3;
    });
    currentY += 3;
  }

  /* ── 6. FAILURE DETAILS & ROOT CAUSE ─────────────────────── */
  if (hasFailures) {
    sectionTitle("Failure Details & Root Cause", "Per Failed Step");
    const allDetails = report.failures.flatMap((f) => f.failureDetails || []);
    allDetails.slice(0, 12).forEach((d, idx) => {
      ensureSpace(34);
      const top = currentY;
      const rows = [
        ["WHAT FAILED", `${d.action} on ${d.selector} (${d.selectorType})`],
        ["WHERE", `${d.scenario}  -  ${d.page}${d.stepNumber ? `  (step ${d.stepNumber})` : ""}`],
        ["EXPECTED", d.expectedResult || "-"],
        ["ACTUAL", d.actualResult || d.error || "-"],
        ["EXACT ERROR", d.error || "-"],
        ["CATEGORY", `${d.failureCategory} - Severity: ${d.severity} - ${d.isApplicationDefect ? "Application defect" : "Not confirmed as application defect"}`],
        ["WHY (likely root cause)", d.likelyRootCause || "-"],
        ["WHAT TO CHECK", d.developerAction || "-"],
        ["SELF-HEALING", d.healed ? "Attempted during this step" : "Not attempted / not applicable"],
        ["EVIDENCE", d.evidence || "Screenshot not available"],
      ];
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      setColor(doc.setTextColor.bind(doc), c.roseDark);
      doc.text(`Failure ${idx + 1}: ${clip(d.scenario, 60)}`, margin, top);
      currentY = top + 4;
      autoTable(doc, {
        startY: currentY,
        body: rows,
        theme: "plain",
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.2, cellPadding: 1.4, valign: "top" },
        columnStyles: {
          0: { fontStyle: "bold", textColor: c.inkMuted, cellWidth: 42 },
          1: { textColor: c.ink },
        },
      });
      currentY = doc.lastAutoTable.finalY + 4;
      setColor(doc.setDrawColor.bind(doc), c.hairline);
      doc.setLineWidth(0.2);
      doc.line(margin, currentY, margin + contentWidth, currentY);
      currentY += 4;
    });
  }

  /* ── 7. SELF-HEALING RESULTS ─────────────────────────────── */
  if (hasHealing) {
    const hs = report.healingSummary || { attempts: report.healing.length, successes: report.healing.filter((h) => h.success).length, failures: 0, recoveryRate: 0 };
    sectionTitle("Self-Healing Results", `${hs.successes}/${hs.attempts} recovered`);
    bodyText(
      `Healing attempts: ${hs.attempts}    Successful recoveries: ${hs.successes}    Failed recoveries: ${hs.failures}    Recovery rate: ${hs.recoveryRate}%`,
      { size: 8, color: c.inkSoft, bold: true }
    );
    currentY += 3;
    const healRows = report.healing.map((h) => [
      `Step ${h.stepIndex ?? "-"}`,
      clip(h.testName, 22),
      h.originalSelector,
      h.success ? h.healedSelector : "-",
      h.recoveryType === "MISSING_SELECTOR_RECOVERY" ? "Missing selector" : "Selector drift",
      h.success ? "RECOVERED" : "FAILED",
    ]);
    autoTable(doc, {
      startY: currentY,
      head: [["Step", "Scenario", "Original Selector", "Recovered Selector", "Trigger", "Result"]],
      body: healRows,
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 7, cellPadding: 1.8 },
      headStyles: { fillColor: c.brandCyan, textColor: c.white },
      didParseCell: (data) => {
        if (data.column.index === 5 && data.section === "body") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = data.cell.text[0] === "RECOVERED" ? c.emerald : c.rose;
        }
      },
    });
    currentY = doc.lastAutoTable.finalY + 4;
    bodyText("A failed healing attempt is never counted as a recovery.", { size: 7, color: c.inkMuted });
    currentY += 6;
  }

  /* ── 8. ACCESSIBILITY ────────────────────────────────────── */
  sectionTitle("Accessibility", report.accessibility.label || report.accessibility.status);
  if (report.accessibility.evaluated) {
    bodyText(
      report.accessibility.status === "COMPLIANT"
        ? "The automated axe-core scan (WCAG 2.1 A / AA) found no violations in the audited DOM states."
        : `${report.accessibility.violations.length} WCAG violation(s) detected - Critical: ${report.accessibility.scores.critical}, Serious: ${report.accessibility.scores.serious}, Moderate: ${report.accessibility.scores.moderate}, Minor: ${report.accessibility.scores.minor}. The affected control(s) should be reviewed before release.`,
      { size: 8, color: report.accessibility.status === "COMPLIANT" ? c.emeraldDark : c.roseDark }
    );
    currentY += 3;
    if (report.accessibility.violations && report.accessibility.violations.length > 0) {
      const violationRows = report.accessibility.violations.slice(0, 20).map((v) => [
        v.id || "-",
        (v.impact || "moderate").toUpperCase(),
        clip(v.description || "No description provided", 82),
        v.nodes ? String(v.nodes) : "-",
      ]);
      autoTable(doc, {
        startY: currentY,
        head: [["Rule ID", "Impact", "Description", "Nodes"]],
        body: violationRows,
        theme: "striped",
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, cellPadding: 2 },
        headStyles: { fillColor: c.brandCyan, textColor: c.white },
        alternateRowStyles: { fillColor: c.panelBg },
        didParseCell: (data) => {
          if (data.column.index === 1 && data.section === "body") {
            const v = String(data.cell.text[0]);
            data.cell.styles.fontStyle = "bold";
            data.cell.styles.textColor = v === "CRITICAL" ? c.rose : v === "SERIOUS" ? [249, 115, 22] : c.amber;
          }
        },
      });
      currentY = doc.lastAutoTable.finalY + 6;
    }
  } else {
    bodyText("Accessibility scan was NOT EVALUATED for this execution (not enabled, or the scan did not complete). No compliance conclusion can be drawn.", { size: 8, color: c.inkMuted });
    currentY += 6;
  }

  /* ── 9. SECURITY SANITY CHECKS ───────────────────────────── */
  sectionTitle("Security Sanity Checks", report.security.label || report.security.status);
  if (report.security.evaluated) {
    bodyText(`Status: ${report.security.label}. Checks performed: ${(report.security.checksPerformed || []).join(", ")}.`, { size: 8, color: c.inkSoft, bold: true });
    currentY += 2;
    bodyText(`Mixed content: ${report.security.issues.mixedContent ? "DETECTED" : "None"} - Insecure form actions: ${report.security.issues.insecureForms ? "DETECTED" : "None"}`, { size: 8, color: c.inkSoft });
    currentY += 2;
    if (report.security.issues.missingHeaders && report.security.issues.missingHeaders.length > 0) {
      bodyText(`Missing security headers: ${report.security.issues.missingHeaders.join(", ")}`, { size: 8, color: c.roseDark, bold: true });
      currentY += 2;
    }
    bodyText(`Scope: ${report.security.scope}`, { size: 7, color: c.inkMuted });
    currentY += 6;
  } else {
    bodyText("Security sanity checks were NOT EVALUATED for this execution. This was never a full security assessment.", { size: 8, color: c.inkMuted });
    currentY += 6;
  }

  /* ── 10. PAGE VALIDATION MATRIX ──────────────────────────── */
  if (hasPageAnalysis) {
    sectionTitle("Page Validation Matrix");
    const pageRows = report.pageAnalysis.map((p) => [
      clip(p.url, 48),
      String(p.stepsExecuted),
      String(p.passed),
      String(p.failed),
      p.status,
      clip((p.issues || []).join(" | ") || "-", 46),
    ]);
    autoTable(doc, {
      startY: currentY,
      head: [["Page URL", "Steps", "Pass", "Fail", "Status", "Issues"]],
      body: pageRows,
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 7, cellPadding: 1.8 },
      headStyles: { fillColor: c.ink, textColor: c.white },
      alternateRowStyles: { fillColor: c.panelBg },
      didParseCell: (data) => {
        if (data.column.index === 4 && data.section === "body") {
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.textColor = data.cell.text[0] === "PASS" ? c.emerald : c.rose;
        }
      },
    });
    currentY = doc.lastAutoTable.finalY + 8;
  }

  /* ── 11. PERFORMANCE ─────────────────────────────────────── */
  sectionTitle("Performance");
  {
    const p = report.performance || {};
    if (!p.evaluated) {
      bodyText("Performance: NOT EVALUATED. No timing telemetry was captured for this execution.", { size: 8, color: c.inkMuted });
      currentY += 6;
    } else {
      const fmtMs = (v) => (v == null ? "N/A" : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(2)} s`);
      const perfRows = [
        ["Execution Duration", p.executionDurationFormatted || fmtMs(p.executionDurationMs)],
        ["Average Step Duration", fmtMs(p.avgStepDurationMs)],
        ["Fastest Step", fmtMs(p.fastestStepMs)],
        ["Slowest Step", fmtMs(p.slowestStepMs)],
        ["Core Web Vitals (LCP / TBT / CLS)", "Not collected by this runner"],
      ];
      autoTable(doc, {
        startY: currentY,
        body: perfRows,
        theme: "grid",
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 2.4 },
        columnStyles: { 0: { fontStyle: "bold", textColor: c.inkMuted, cellWidth: 70 }, 1: { textColor: c.ink } },
      });
      currentY = doc.lastAutoTable.finalY + 3;
      bodyText(p.note || "Derived from step execution timing.", { size: 7, color: c.inkMuted });
      currentY += 6;
    }
  }

  /* ── 12. SCREENSHOT / EVIDENCE ───────────────────────────── */
  {
    const shots = report.evidence.screenshots || [];
    const vids = report.evidence.videos || [];
    sectionTitle("Screenshot / Evidence", `${shots.length + vids.length}`);

    if (shots.length === 0 && vids.length === 0) {
      bodyText("Evidence unavailable - no screenshots or video were captured for this execution.", { size: 8.5, color: c.inkMuted });
      currentY += 4;
    } else {
      // Embed the actual images (failure-state first), capped to keep the PDF
      // a sensible size. Any beyond the cap are listed in the table below.
      const EMBED_CAP = 4;
      const ordered = [...shots].sort((a, b) => (b.isFailure ? 1 : 0) - (a.isFailure ? 1 : 0));
      const toEmbed = ordered.slice(0, EMBED_CAP);
      const remaining = ordered.slice(EMBED_CAP);

      for (const sh of toEmbed) {
        const dataUrl = await fetchImageDataUrl(sh.url);
        // caption
        ensureSpace(10);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        setColor(doc.setTextColor.bind(doc), sh.isFailure ? c.roseDark : c.ink);
        doc.text(clip(sh.title || "Snapshot", 70), margin, currentY);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        setColor(doc.setTextColor.bind(doc), c.inkMuted);
        const ctx = [
          sh.isFailure ? "Failure state" : "Standard",
          sh.stepLabel || (sh.stepIndex ? `failed step ${sh.stepIndex}` : null),
          sh.timestamp,
        ].filter(Boolean).join(" - ");
        currentY += 3.6;
        doc.text(clip(ctx, 110), margin, currentY);
        currentY += 3;

        if (dataUrl) {
          let iw = 1200, ih = 800;
          try { const p = doc.getImageProperties(dataUrl); if (p && p.width && p.height) { iw = p.width; ih = p.height; } } catch { /* use 3:2 default */ }
          const maxW = Math.min(contentWidth, 130);
          const maxH = 95;
          let w = maxW;
          let h = (ih / iw) * w;
          if (h > maxH) { h = maxH; w = (iw / ih) * h; }
          ensureSpace(h + 6);
          try {
            const fmt = /^data:image\/jpe?g/i.test(dataUrl) ? "JPEG" : "PNG";
            doc.addImage(dataUrl, fmt, margin, currentY, w, h);
            setColor(doc.setDrawColor.bind(doc), c.hairline);
            doc.setLineWidth(0.3);
            doc.rect(margin, currentY, w, h);
            currentY += h + 6;
          } catch {
            bodyText("Image could not be embedded (format unsupported). URL is in the Failure Details / dashboard.", { size: 7, color: c.inkMuted });
            currentY += 2;
          }
        } else {
          bodyText("Image unavailable - could not be fetched (it may require authentication or has expired). See the interactive report on the NovaTest AI dashboard.", { size: 7, color: c.inkMuted });
          currentY += 2;
        }
      }

      if (remaining.length > 0) {
        bodyText(`+ ${remaining.length} additional screenshot(s) (not embedded to keep this PDF small):`, { size: 7.5, color: c.inkMuted, bold: true });
        currentY += 1;
        autoTable(doc, {
          startY: currentY,
          head: [["Screenshot", "Captured At", "Context"]],
          body: remaining.slice(0, 15).map((sh) => [
            clip(sh.title || "Snapshot", 40),
            sh.timestamp || "-",
            sh.isFailure ? "Failure State" : "Standard",
          ]),
          theme: "striped",
          margin: { left: margin, right: margin },
          styles: { fontSize: 7.5, cellPadding: 2 },
          headStyles: { fillColor: c.ink, textColor: c.white },
          alternateRowStyles: { fillColor: c.panelBg },
        });
        currentY = doc.lastAutoTable.finalY + 6;
      }

      vids.forEach((v) => {
        ensureSpace(6);
        bodyText(`Video Replay - ${v.browser || "chromium"}, ${v.durationFormatted || "duration unknown"} (viewable on the NovaTest AI dashboard)`, { size: 8, color: c.inkSoft });
      });
      bodyText("Full-resolution media is available in the interactive report on the NovaTest AI dashboard.", { size: 7, color: c.inkMuted });
      currentY += 4;
    }
  }

  // Bug Tracking - linked Jira ticket, when the run auto-filed one on failure
  if (hasJira) {
    sectionTitle("Bug Tracking", "Jira Integration");
    const jiraRows = [
      ["Ticket ID", report.metadata.jiraTicketId || "-"],
      ["Ticket URL", report.metadata.jiraTicketUrl || "Not available"],
      ["Synced At", report.metadata.jiraTicketUrl && report.metadata.jiraSyncTimestamp ? new Date(report.metadata.jiraSyncTimestamp).toLocaleString() : "-"],
    ];
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    jiraRows.forEach(([label, value], idx) => {
      const rowY = currentY + idx * 5.5;
      setColor(doc.setTextColor.bind(doc), c.inkMuted);
      doc.text(label, margin, rowY);
      setColor(doc.setTextColor.bind(doc), c.brandIndigo);
      doc.setFont("helvetica", "bold");
      const lines = doc.splitTextToSize(String(value), contentWidth - 40);
      doc.text(lines[0], margin + 32, rowY);
      doc.setFont("helvetica", "normal");
    });
    currentY += jiraRows.length * 5.5 + 6;
  }

  /* ── 13. AI INSIGHTS ─────────────────────────────────────── */
  if (hasAiInsights) {
    sectionTitle("AI Insights", "Explanatory - Not Authoritative");
    if (hasObservations) {
      report.ai.observations.slice(0, 8).forEach((obs) => {
        ensureSpace(10);
        const tagColor = obs.type === "RISK" ? c.rose : obs.type === "WARNING" ? c.amber : obs.type === "SUCCESS" ? c.emerald : c.brandIndigo;
        statusDot(margin + 1.3, currentY - 1.3, tagColor, 1.3);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        setColor(doc.setTextColor.bind(doc), tagColor);
        doc.text(obs.type, margin + 5, currentY);
        doc.setFont("helvetica", "normal");
        setColor(doc.setTextColor.bind(doc), c.ink);
        doc.text(clip(obs.title, 70), margin + 24, currentY);
        currentY += 4.5;
        if (obs.description) currentY += bodyText(obs.description, { size: 7.8, indent: 3, lineHeight: 3.8 });
        currentY += 2;
      });
      currentY += 2;
    }
    if (hasDetectedIssues) {
      bodyText("AI-Detected Issues", { size: 8, color: c.inkMuted, bold: true });
      currentY += 1;
      const issueRows = report.ai.detectedIssues.slice(0, 15).map((issue) => {
        if (typeof issue === "string") return ["-", clip(issue, 90), "-"];
        return [issue.severity || issue.type || "INFO", clip(issue.description || issue.message || String(issue), 90), issue.location || issue.source || "-"];
      });
      autoTable(doc, {
        startY: currentY,
        head: [["Severity", "Description", "Location"]],
        body: issueRows,
        theme: "striped",
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, cellPadding: 2 },
        headStyles: { fillColor: c.amber, textColor: c.white },
        alternateRowStyles: { fillColor: c.panelBg },
      });
      currentY = doc.lastAutoTable.finalY + 6;
    }
    if (hasRecommendations) {
      bodyText("Recommended Actions", { size: 8, color: c.inkMuted, bold: true });
      currentY += 1;
      report.ai.recommendations.forEach((rec, idx) => {
        ensureSpace(6);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        setColor(doc.setTextColor.bind(doc), c.brandIndigo);
        doc.text(`[${String(idx + 1).padStart(2, "0")}]`, margin, currentY);
        doc.setFont("helvetica", "normal");
        setColor(doc.setTextColor.bind(doc), c.inkSoft);
        const recLines = doc.splitTextToSize(rec, contentWidth - 12);
        doc.text(recLines, margin + 10, currentY);
        currentY += recLines.length * 4.2 + 1.5;
      });
      currentY += 4;
    }
  }

  /* ── 14. RAW EXECUTION TIMELINE ──────────────────────────── */
  if (hasTimeline) {
    sectionTitle("Raw Execution Timeline", `${report.timeline.length} events`);
    const timelineRows = report.timeline.slice(0, 70).map((ev) => [
      ev.timestamp || "-",
      ev.action || "-",
      ev.target ? clip(String(ev.target), 42) : "-",
      (ev.status || "INFO").toUpperCase(),
    ]);
    autoTable(doc, {
      startY: currentY,
      head: [["Time", "Action", "Target", "Status"]],
      body: timelineRows,
      theme: "grid",
      margin: { left: margin, right: margin },
      styles: { fontSize: 7, cellPadding: 1.6, font: "courier" },
      headStyles: { fillColor: c.brandIndigo, textColor: c.white, font: "helvetica" },
      alternateRowStyles: { fillColor: c.panelBg },
      didParseCell: (data) => {
        if (data.column.index === 3 && data.section === "body") {
          const val = String(data.cell.text[0]);
          data.cell.styles.fontStyle = "bold";
          data.cell.styles.font = "helvetica";
          data.cell.styles.textColor = val.includes("FAIL") || val.includes("ERROR") ? c.rose : val.includes("PASS") || val === "SUCCESS" ? c.emerald : c.inkMuted;
        }
      },
    });
    currentY = doc.lastAutoTable.finalY + 4;
    if (report.timeline.length > 70) {
      bodyText(`+ ${report.timeline.length - 70} more event(s) - see the full report on the NovaTest AI dashboard.`, { size: 7, color: c.inkMuted });
    }
    currentY += 6;
  }

  /* ── TECHNICAL APPENDIX ──────────────────────────────────── */
  sectionTitle("Technical Appendix", "For QA Engineers");
  const techRows = [
    ["Execution ID", report.metadata.id],
    ["Recorded Step Events", String(report.technical.stepLogs?.length || 0)],
    ["Full Execution Trace", report.technical.traceData ? "Available on dashboard" : "Not captured"],
    ["Execution Plan Data", report.technical.planData ? "Available on dashboard" : "Not captured"],
    ["Raw Console/Runtime Logs", report.technical.rawLogs ? `${report.technical.rawLogs.length.toLocaleString()} characters captured` : "None captured"],
    ["Started / Completed", `${report.metadata.createdAtFormatted}  →  ${report.metadata.completedAt ? new Date(report.metadata.completedAt).toLocaleString() : "N/A"}`],
  ];
  autoTable(doc, {
    startY: currentY,
    body: techRows,
    theme: "grid",
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 2.5, font: "courier" },
    columnStyles: {
      0: { fontStyle: "bold", textColor: c.inkMuted, cellWidth: 55, font: "helvetica" },
      1: { textColor: c.ink },
    },
  });
  currentY = doc.lastAutoTable.finalY + 4;

  // Raw execution logs - verbatim, so nothing is lost from the PDF.
  if (report.technical.rawLogs) {
    bodyText("RAW EXECUTION LOGS", { size: 8, color: c.inkMuted, bold: true });
    currentY += 1;
    let rawLogText = report.technical.rawLogs;
    try {
      const parsed = JSON.parse(rawLogText);
      if (Array.isArray(parsed)) rawLogText = parsed.join("\n");
    } catch { /* not JSON, use as-is */ }
    doc.setFont("courier", "normal");
    doc.setFontSize(6.2);
    setColor(doc.setTextColor.bind(doc), c.inkSoft);
    const logLines = doc.splitTextToSize(rawLogText.slice(0, 14000), contentWidth);
    logLines.forEach((ln) => {
      ensureSpace(3.2);
      doc.text(ln, margin, currentY);
      currentY += 2.9;
    });
    doc.setFont("helvetica", "normal");
    if (rawLogText.length > 14000) {
      currentY += 2;
      bodyText(`... log truncated at 14,000 characters (${rawLogText.length.toLocaleString()} total). Full logs on the dashboard.`, { size: 7, color: c.inkMuted });
    }
    currentY += 4;
  }
  bodyText("This document is a point-in-time snapshot. For live telemetry, video replay, and full-resolution screenshots, refer to this run's page on the NovaTest AI dashboard.", { size: 7, color: c.inkMuted });

  /* ══════════════════════════════════════════════════════════
   * RUNNING HEADER / FOOTER (applied to all content pages)
   * ══════════════════════════════════════════════════════════ */
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 2; i <= totalPages; i++) {
    doc.setPage(i);

    // Header
    let headerTextX = margin;
    if (logoDataUrl) {
      const miniLogoW = 9;
      const miniLogoH = 3.25;
      doc.addImage(logoDataUrl, "JPEG", margin, 6.5, miniLogoW, miniLogoH);
      headerTextX = margin + miniLogoW + 3;
    }
    setColor(doc.setTextColor.bind(doc), c.inkMuted);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.text("NOVATEST AI - TEST INTELLIGENCE REPORT", headerTextX, 10);
    doc.setFont("helvetica", "normal");
    doc.text(`Run #${report.metadata.runNumber}`, pageWidth - margin, 10, { align: "right" });
    setColor(doc.setDrawColor.bind(doc), c.hairline);
    doc.setLineWidth(0.3);
    doc.line(margin, 13, pageWidth - margin, 13);

    // Footer
    doc.setLineWidth(0.3);
    doc.line(margin, pageHeight - 14, pageWidth - margin, pageHeight - 14);
    doc.setFontSize(7);
    setColor(doc.setTextColor.bind(doc), c.inkMuted);
    doc.text("Confidential - Generated by NovaTest AI", margin, pageHeight - 9);
    doc.text(`Page ${i - 1} of ${totalPages - 1}`, pageWidth - margin, pageHeight - 9, { align: "right" });
  }

  // Cover page footer (no page number - it's the title page)
  doc.setPage(1);
  setColor(doc.setDrawColor.bind(doc), c.hairline);
  doc.setLineWidth(0.3);
  doc.line(margin, pageHeight - 14, pageWidth - margin, pageHeight - 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  setColor(doc.setTextColor.bind(doc), c.inkMuted);
  doc.text("Confidential - Generated by NovaTest AI", margin, pageHeight - 9);
  doc.text(`${totalPages} page(s) total`, pageWidth - margin, pageHeight - 9, { align: "right" });

  const filename = `NovaTest_Report_${report.metadata.runNumber}.pdf`;
  if (options.download) {
    doc.save(filename);
  }
  return doc.output("blob");
}

/**
 * Generates and downloads Standalone Interactive HTML.
 */
export function generateReportHtml(report) {
  if (!report) return;

  const htmlContent = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NovaTest AI Report - ${report.metadata.suiteName} (#${report.metadata.runNumber})</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-page: #080c14;
      --bg-panel: rgba(16, 22, 38, 0.85);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --accent-indigo: #6366f1;
      --accent-cyan: #06b6d4;
      --accent-emerald: #10b981;
      --accent-rose: #f43f5e;
      --accent-amber: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      background-color: var(--bg-page);
      color: var(--text-primary);
      padding: 32px 20px;
      line-height: 1.5;
    }
    .container { max-width: 1280px; margin: 0 auto; }
    .header {
      background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(6,182,212,0.1));
      border: 1px solid var(--border-subtle);
      border-radius: 20px;
      padding: 28px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-approved { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-blocked { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
    .badge-conditional { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .hero-panel {
      border-radius: 20px;
      padding: 24px;
      margin-bottom: 24px;
      border: 1px solid;
    }
    .hero-approved { background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.3); }
    .hero-blocked { background: rgba(244, 63, 94, 0.08); border-color: rgba(244, 63, 94, 0.3); }
    .hero-conditional { background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.3); }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--bg-panel);
      border: 1px solid var(--border-subtle);
      border-radius: 16px;
      padding: 20px;
    }
    .kpi-val { font-size: 28px; font-weight: 800; margin-top: 4px; }
    .kpi-lbl { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; }
    .table-box { overflow-x: auto; margin-top: 12px; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { padding: 12px 16px; background: rgba(255,255,255,0.03); color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
    td { padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); }
    .tag-pass { color: #34d399; font-weight: 700; }
    .tag-fail { color: #fb7185; font-weight: 700; }
    .search-input {
      width: 100%;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border-subtle);
      padding: 10px 16px;
      border-radius: 10px;
      color: white;
      font-size: 13px;
      margin-bottom: 12px;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent-indigo); }
    .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
    .collapsible-btn {
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      color: inherit;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
    }
    pre {
      background: #020617;
      padding: 16px;
      border-radius: 12px;
      overflow-x: auto;
      font-size: 12px;
      color: #93c5fd;
      border: 1px solid rgba(255,255,255,0.05);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div>
        <span class="badge" style="background: rgba(99,102,241,0.2); color: #818cf8; border: 1px solid rgba(99,102,241,0.4);">
          NOVATEST AI QUALITY REPORT
        </span>
        <h1 style="font-size: 24px; font-weight: 800; margin-top: 6px;">${report.metadata.suiteName}</h1>
        ${report.metadata.testDescription ? `<p style="color: var(--text-secondary); font-size: 13px; margin-top: 6px; max-width: 640px;">${report.metadata.testDescription}</p>` : ""}
        <p style="color: var(--text-secondary); font-size: 12px; margin-top: 8px;">
          Run #${report.metadata.runNumber} &bull; Executed ${report.metadata.createdAtFormatted} &bull; Browser: ${report.metadata.browser}
          ${report.metadata.targetUrl ? ` &bull; Target: <a href="${report.metadata.targetUrl}" style="color: var(--accent-cyan);" target="_blank" rel="noreferrer">${report.metadata.targetUrl}</a>` : ""}
        </p>
      </div>
      <div>
        <span class="badge ${report.releaseDecision.decision === 'APPROVED' ? 'badge-approved' : report.releaseDecision.decision === 'BLOCKED' ? 'badge-blocked' : 'badge-conditional'}" style="font-size: 13px; padding: 6px 14px;">
          ${report.releaseDecision.title}
        </span>
      </div>
    </div>

    <!-- Release Hero -->
    <div class="hero-panel ${report.releaseDecision.decision === 'APPROVED' ? 'hero-approved' : report.releaseDecision.decision === 'BLOCKED' ? 'hero-blocked' : 'hero-conditional'}">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px;">
        <h2 style="font-size: 18px; font-weight: 800;">AI Release Evaluation</h2>
        <div style="display: flex; gap: 12px; font-weight: 700; font-size: 13px;">
          <span>Health: ${report.releaseDecision.healthScore}/100</span>
          <span>Risk: ${report.releaseDecision.riskLevel}</span>
          <span>Confidence: ${report.releaseDecision.confidence}%</span>
        </div>
      </div>
      <ul style="padding-left: 20px; font-size: 13px; color: var(--text-secondary);">
        ${report.releaseDecision.reasons.map((r) => `<li style="margin-bottom: 4px;">${r}</li>`).join("")}
      </ul>
    </div>

    <!-- KPIs -->
    <div class="kpi-grid">
      <div class="card">
        <div class="kpi-lbl">Health Score</div>
        <div class="kpi-val" style="color: #10b981;">${report.summary.healthScore}%</div>
      </div>
      <div class="card">
        <div class="kpi-lbl">Pass Rate</div>
        <div class="kpi-val" style="color: #6366f1;">${report.summary.passRate}%</div>
      </div>
      <div class="card">
        <div class="kpi-lbl">Tests Executed</div>
        <div class="kpi-val">${report.summary.totalTests}</div>
      </div>
      <div class="card">
        <div class="kpi-lbl">Passed / Failed</div>
        <div class="kpi-val">${report.summary.passedCount} / <span style="color: #f43f5e;">${report.summary.failedCount}</span></div>
      </div>
      <div class="card">
        <div class="kpi-lbl">Self-Healed</div>
        <div class="kpi-val" style="color: #06b6d4;">${report.summary.selfHealedCount}</div>
      </div>
      <div class="card">
        <div class="kpi-lbl">Duration</div>
        <div class="kpi-val">${report.metadata.durationFormatted}</div>
      </div>
    </div>

    <!-- AI Summary -->
    <div class="card" style="margin-bottom: 24px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
        <h3 style="font-size: 15px; font-weight: 700;">AI Executive Summary</h3>
        <span class="badge" style="background: rgba(99,102,241,0.15); color: #a5b4fc;">AI OBSERVABILITY</span>
      </div>
      <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">${report.summary.aiSummaryText}</p>
    </div>

    <!-- Test Scenarios Table -->
    <div class="card" style="margin-bottom: 24px;">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px;">Test Scenarios Matrix</h3>
      <input type="text" id="filterInput" class="search-input" placeholder="Search scenarios..." onkeyup="filterScenarios()">
      <div class="table-box">
        <table id="scenariosTable">
          <thead>
            <tr>
              <th>Status</th>
              <th>Scenario</th>
              <th>Duration</th>
              <th>Risk</th>
              <th>Self-Healed</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${report.tests
              .map(
                (t) => `
              <tr>
                <td><span class="${t.status === "PASSED" ? "tag-pass" : "tag-fail"}">${t.status === "PASSED" ? "✓ PASS" : "✕ FAIL"}</span></td>
                <td style="font-weight: 600;">${t.name}</td>
                <td class="mono">${t.durationMs ? (t.durationMs / 1000).toFixed(2) + "s" : "<1s"}</td>
                <td>${t.risk}</td>
                <td>${t.healed ? '<span class="badge badge-approved">Healed</span>' : "-"}</td>
                <td style="color: var(--text-secondary); max-width: 300px;">${t.error || "Verified successfully"}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recommendations -->
    ${
      report.ai.recommendations.length > 0
        ? `
      <div class="card" style="margin-bottom: 24px;">
        <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px;">Recommended Actions</h3>
        <div style="display: grid; gap: 8px;">
          ${report.ai.recommendations
            .map(
              (r, i) => `
            <div style="padding: 12px 16px; background: rgba(255,255,255,0.02); border: 1px solid var(--border-subtle); border-radius: 10px; font-size: 13px;">
              <strong style="color: var(--accent-indigo); margin-right: 8px;">0${i + 1}</strong> ${r}
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `
        : ""
    }

    <!-- Technical Appendix Collapsible -->
    <div class="card">
      <button class="collapsible-btn" onclick="toggleLogs()">
        <span>Technical Execution Logs</span>
        <span id="logToggleIcon">▼</span>
      </button>
      <div id="logsContainer" style="display: none; margin-top: 12px;">
        <pre>${report.technical.rawLogs || "No text logs generated for this execution."}</pre>
      </div>
    </div>
  </div>

  <script>
    function filterScenarios() {
      const q = document.getElementById('filterInput').value.toLowerCase();
      const rows = document.querySelectorAll('#scenariosTable tbody tr');
      rows.forEach(r => {
        r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
      });
    }
    function toggleLogs() {
      const el = document.getElementById('logsContainer');
      const icon = document.getElementById('logToggleIcon');
      if (el.style.display === 'none') {
        el.style.display = 'block';
        icon.innerText = '▲';
      } else {
        el.style.display = 'none';
        icon.innerText = '▼';
      }
    }
  </script>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
  triggerBrowserDownload(blob, `NovaTest_Report_${report.metadata.runNumber}.html`);
}

/**
 * Downloads raw normalized JSON.
 */
export function generateReportJson(report) {
  if (!report) return;
  const jsonStr = JSON.stringify(report, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
  triggerBrowserDownload(blob, `NovaTest_Report_${report.metadata.runNumber}.json`);
}

/**
 * Generates a Complete ZIP bundle (HTML, PDF, JSON).
 */
export async function generateReportZip(report) {
  if (!report) return;

  const zip = new JSZip();

  // 1. JSON Data
  zip.file(`NovaTest_Report_${report.metadata.runNumber}.json`, JSON.stringify(report, null, 2));

  // 2. HTML Standalone
  const htmlBlob = new Blob(
    [
      `<!DOCTYPE html><html><head><title>NovaTest Report ${report.metadata.runNumber}</title></head><body style="font-family:sans-serif;padding:20px;"><h1>NovaTest AI Report #${report.metadata.runNumber}</h1><pre>${JSON.stringify(report.summary, null, 2)}</pre></body></html>`,
    ],
    { type: "text/html" }
  );
  zip.file("report.html", htmlBlob);

  // 3. Generate PDF Blob
  try {
    const pdfBlob = await generateReportPdf(report, { download: false });
    if (pdfBlob) {
      zip.file(`NovaTest_Report_${report.metadata.runNumber}.pdf`, pdfBlob);
    }
  } catch (err) {
    console.error("Failed to append PDF to zip", err);
  }

  // 4. Screenshots Manifest
  if (report.evidence.screenshots && report.evidence.screenshots.length > 0) {
    const manifest = report.evidence.screenshots.map((s, idx) => ({
      index: idx + 1,
      title: s.title,
      url: s.url,
      timestamp: s.timestamp,
    }));
    zip.file("screenshots_manifest.json", JSON.stringify(manifest, null, 2));
  }

  // Generate & Download Zip
  const zipBlob = await zip.generateAsync({ type: "blob" });
  triggerBrowserDownload(zipBlob, `NovaTest_Report_${report.metadata.runNumber}.zip`);
}
