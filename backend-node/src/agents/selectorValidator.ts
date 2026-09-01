export function validateSelector(selector: string, domContext: string): { valid: boolean; reason?: string } {
    if (!selector || selector.trim() === '') {
        return { valid: false, reason: 'Selector is empty' };
    }
    
    const lowerDom = domContext.toLowerCase();
    const lowerSelector = selector.toLowerCase();
    
    // Check invalid APIs
    const invalidApis = ['.closest', '.queryselector', '.parentelement', '.parentnode', '.children', '.childnodes'];
    for (const api of invalidApis) {
        if (lowerSelector.includes(api)) {
            return { valid: false, reason: `Invalid native DOM API used on Playwright Locator: ${api}` };
        }
    }

    // Check data-testid explicitly inside string (e.g., locator('[data-testid="password"]'))
    const dataTestIdMatch = selector.match(/data-testid=["']([^"']+)["']/i);
    if (dataTestIdMatch && dataTestIdMatch[1]) {
        const val = dataTestIdMatch[1].toLowerCase();
        if (!lowerDom.includes(`data-testid="${val}"`) && !lowerDom.includes(`data-testid='${val}'`)) {
            return { valid: false, reason: `Attribute data-testid="${val}" not present in current DOM` };
        }
    }

    // Check getByTestId (Playwright's getByTestId checks data-testid by default)
    const getByTestIdMatch = selector.match(/getByTestId\(['"]([^'"]+)['"]\)/i);
    if (getByTestIdMatch && getByTestIdMatch[1]) {
        const val = getByTestIdMatch[1].toLowerCase();
        if (!lowerDom.includes(`data-testid="${val}"`) && !lowerDom.includes(`data-testid='${val}'`)) {
            return { valid: false, reason: `Attribute data-testid="${val}" not present in current DOM` };
        }
    }

    // Check data-test
    const dataTestMatch = selector.match(/\[data-test=["']([^"']+)["']/i);
    if (dataTestMatch && dataTestMatch[1]) {
        const val = dataTestMatch[1].toLowerCase();
        if (!lowerDom.includes(`data-test="${val}"`) && !lowerDom.includes(`data-test='${val}'`)) {
            return { valid: false, reason: `Attribute data-test="${val}" not present in current DOM` };
        }
    }

    // Check name attribute
    const nameMatch = selector.match(/\[name=["']([^"']+)["']/i);
    if (nameMatch && nameMatch[1]) {
        const val = nameMatch[1].toLowerCase();
        if (!lowerDom.includes(`name="${val}"`) && !lowerDom.includes(`name='${val}'`)) {
            return { valid: false, reason: `Attribute name="${val}" not present in current DOM` };
        }
    }

    // Check id (e.g. locator('#password') or locator('[id="password"]'))
    const idMatch = selector.match(/\[id=["']([^"']+)["']/i) || selector.match(/locator\(['"]#([^'"]+)['"]\)/i);
    if (idMatch && idMatch[1]) {
        const val = idMatch[1].toLowerCase();
        if (!lowerDom.includes(`id="${val}"`) && !lowerDom.includes(`id='${val}'`)) {
            return { valid: false, reason: `Attribute id="${val}" not present in current DOM` };
        }
    }

    // Check placeholder / getByPlaceholder
    const placeholderMatch = selector.match(/getByPlaceholder\(\/([^/]+)\/i?\)/i) || selector.match(/getByPlaceholder\(['"]([^'"]+)['"]\)/i) || selector.match(/\[placeholder=["']([^"']+)["']/i);
    if (placeholderMatch && placeholderMatch[1]) {
        const val = placeholderMatch[1].toLowerCase();
        if (!lowerDom.includes(`placeholder="${val}"`) && !lowerDom.includes(`placeholder='${val}'`)) {
            let found = false;
            const domPlaceholders = Array.from(lowerDom.matchAll(/placeholder=["']([^"']+)["']/g));
            for (const m of domPlaceholders) {
                if (m[1] && m[1].toLowerCase().includes(val)) {
                    found = true; break;
                }
            }
            if (!found) {
                return { valid: false, reason: `Placeholder "${val}" not present in current DOM` };
            }
        }
    }

    // Check getByRole
    const getByRoleMatch = selector.match(/getByRole\(['"]([^'"]+)['"](?:,\s*\{\s*name:\s*(?:\/([^/]+)\/i?|['"]([^'"]+)['"])\s*\})?\)/i);
    if (getByRoleMatch && getByRoleMatch[1]) {
        const role = getByRoleMatch[1].toLowerCase();
        let nameMatchStr = getByRoleMatch[2] || getByRoleMatch[3];
        if (nameMatchStr) {
            nameMatchStr = nameMatchStr.toLowerCase();
            // Need both the tag/role and the text string
            // Simplification: Check if the text exists in the DOM. 
            if (!lowerDom.includes(nameMatchStr)) {
                return { valid: false, reason: `getByRole name "${nameMatchStr}" not present in current DOM` };
            }
        }
        if (role === 'button') {
            // we trust the nameMatchStr check above; structural checks are too flaky with DOM Summary
        }
        if (role === 'link') {
            // we trust the nameMatchStr check above; structural checks are too flaky with DOM Summary
        }
    }

    // Check getByText
    const getByTextMatch = selector.match(/getByText\(\/([^/]+)\/i?\)/i) || selector.match(/getByText\(['"]([^'"]+)['"]\)/i);
    if (getByTextMatch && getByTextMatch[1]) {
        const val = getByTextMatch[1].toLowerCase();
        if (!lowerDom.includes(val)) {
            return { valid: false, reason: `Text "${val}" not present in current DOM` };
        }
    }

    // Check getByLabel
    const getByLabelMatch = selector.match(/getByLabel\(\/([^/]+)\/i?\)/i) || selector.match(/getByLabel\(['"]([^'"]+)['"]\)/i);
    if (getByLabelMatch && getByLabelMatch[1]) {
        const val = getByLabelMatch[1].toLowerCase();
        if (!lowerDom.includes(val) && !lowerDom.includes(`aria-label="${val}"`)) {
            return { valid: false, reason: `Label "${val}" not present in current DOM` };
        }
    }

    // Additional check to prevent text queries from being falsely matched across generic selectors
    if (selector.includes('text=') || selector.includes('contains=')) {
        const textLiteralMatch = selector.match(/text=["']?([^"']+)["']?/i);
        if (textLiteralMatch && textLiteralMatch[1]) {
            const val = textLiteralMatch[1].toLowerCase();
            if (!lowerDom.includes(val)) {
                return { valid: false, reason: `Text literal "${val}" not present in current DOM` };
            }
        }
    }

    return { valid: true };
}
