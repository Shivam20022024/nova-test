import * as xlsx from 'xlsx';

// Case/whitespace-insensitive lookup so column headers like "Test Scenario",
// "Scenario Name", or "Description" are still picked up instead of falling
// through to a generic placeholder. Returns the matched original column key
// too, so callers can avoid re-using the same cell for a different field.
function getFieldEx(row: any, candidates: string[]): { value: string; key: string | null } {
  const normalizedRow: Record<string, any> = {};
  const keyMap: Record<string, string> = {};
  for (const key of Object.keys(row)) {
    const norm = key.trim().toLowerCase().replace(/[\s_-]+/g, '');
    normalizedRow[norm] = row[key];
    keyMap[norm] = key;
  }
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase().replace(/[\s_-]+/g, '');
    const value = normalizedRow[normalizedCandidate];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return { value: String(value).trim(), key: keyMap[normalizedCandidate] ?? null };
    }
  }
  return { value: '', key: null };
}

function getField(row: any, candidates: string[]): string {
  return getFieldEx(row, candidates).value;
}

// Column headers we recognize, used to locate the real header row when it
// isn't row 1 (e.g. a title or URL note sits above the actual table).
const KNOWN_HEADER_WORDS = new Set([
  'scenario', 'testscenario', 'scenarioname', 'testcase', 'testcasename',
  'name', 'title', 'description', 'steps', 'teststeps', 'testdata',
  'expectedresult', 'targeturl', 'url',
]);

function normalizeHeaderCell(v: any): string {
  return String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// sheet_to_json() assumes row 1 holds the headers. When a URL note or title
// sits above the real table, that assumption breaks and every column key
// ends up mangled (e.g. "__EMPTY"), so every getFieldEx() lookup silently
// fails. This scans the first several raw rows for one that actually looks
// like a header (contains a recognized column name) and parses from there.
function parseSheetRows(sheet: xlsx.WorkSheet): any[] {
  const rawRows: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false }) as any[][];
  if (rawRows.length === 0) return [];

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const row = rawRows[i] || [];
    const hasKnownHeader = row.some((cell) => KNOWN_HEADER_WORDS.has(normalizeHeaderCell(cell)));
    if (hasKnownHeader) {
      headerRowIdx = i;
      break;
    }
  }

  const headerRow = (rawRows[headerRowIdx] || []).map((h) => String(h ?? '').trim());
  return rawRows
    .slice(headerRowIdx + 1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => {
      const obj: Record<string, any> = {};
      headerRow.forEach((header, idx) => {
        if (header) obj[header] = row[idx];
      });
      return obj;
    });
}

// Finds a URL anywhere in the worksheet — not just in a named "URL" column.
// Handles URLs written as a standalone cell at the top of the sheet, mixed
// into test data/steps cells, or scattered between test cases. Cells are
// read directly off the raw sheet object (not sheet_to_json), so this also
// catches header/note rows that a column-based parse would never see.
function findUrlAnywhereInSheet(sheet: xlsx.WorkSheet): string {
  const urlRegex = /https?:\/\/[^\s,;"'<>()]+/gi;
  const counts: Record<string, number> = {};

  for (const cellRef of Object.keys(sheet)) {
    if (cellRef.startsWith('!')) continue;
    const cell = (sheet as any)[cellRef];
    if (!cell || cell.v === undefined || cell.v === null) continue;
    const matches = String(cell.v).match(urlRegex);
    if (!matches) continue;
    for (const raw of matches) {
      const cleaned = raw.replace(/[.,;:)]+$/, '');
      counts[cleaned] = (counts[cleaned] || 0) + 1;
    }
  }

  const entries = Object.entries(counts);
  if (entries.length === 0) return '';
  entries.sort((a, b) => b[1] - a[1]); // most frequently repeated URL wins
  return entries[0]?.[0] || '';
}

export class ExcelBatchProcessor {
  public parseExcel(buffer: Buffer): { testcases: any[]; detectedUrl: string } {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return { testcases: [], detectedUrl: '' };
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return { testcases: [], detectedUrl: '' };
    const data = parseSheetRows(sheet);

    // Normalize data. Field lookups also record which raw column they
    // consumed, so the scenario-name fallback below never grabs a cell
    // already claimed by another field.
    const testcases = data.map((row: any) => {
      const stepsField = getFieldEx(row, ['Steps', 'Test Steps']);
      const testDataField = getFieldEx(row, ['TestData', 'Test Data']);
      const expectedField = getFieldEx(row, ['ExpectedResult', 'Expected Result']);
      const urlField = getFieldEx(row, ['TargetUrl', 'Target URL', 'URL']);
      let scenarioField = getFieldEx(row, ['Scenario', 'Test Scenario', 'Scenario Name', 'Test Case', 'Test Case Name', 'Name', 'Title', 'Description']);

      // Fallback: the sheet's header for the scenario/description column
      // didn't match any known name. Grab the first remaining text-like
      // cell in the row instead of leaving the scenario "Untitled".
      if (!scenarioField.value) {
        const consumedKeys = new Set([stepsField.key, testDataField.key, expectedField.key, urlField.key].filter(Boolean));
        for (const key of Object.keys(row)) {
          if (consumedKeys.has(key)) continue;
          const raw = row[key];
          if (raw === undefined || raw === null) continue;
          const str = String(raw).trim();
          if (!str) continue;
          if (/^https?:\/\//i.test(str)) continue; // skip URLs
          if (/^-?\d+(\.\d+)?$/.test(str)) continue; // skip pure numeric/ID cells
          scenarioField = { value: str, key };
          break;
        }
      }

      return {
        scenario: scenarioField.value,
        steps: stepsField.value,
        testData: testDataField.value || '{}',
        expectedResult: expectedField.value,
        targetUrl: urlField.value,
      };
    });

    // Prefer an explicit per-row URL column; otherwise scan the whole sheet
    // for anything URL-shaped (top-of-sheet note, embedded in test data, etc.)
    let detectedUrl = testcases.find((tc) => tc.targetUrl)?.targetUrl || '';
    if (!detectedUrl) {
      detectedUrl = findUrlAnywhereInSheet(sheet);
    }

    // Backfill rows that didn't have their own explicit URL so downstream
    // execution still has a target even if the sheet only stated it once.
    if (detectedUrl) {
      testcases.forEach((tc) => {
        if (!tc.targetUrl) tc.targetUrl = detectedUrl;
      });
    }

    return { testcases, detectedUrl };
  }
}
