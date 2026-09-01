from typing import List, Dict, Any

class PlaywrightCodeGen:
    @staticmethod
    def generate_spec(test_name: str, base_url: str, steps: List[Dict[str, Any]]) -> str:
        """
        Converts generic JSON test steps into a fully formed Playwright .spec.ts file.
        """
        safe_name = test_name.replace('"', '\\"')
        
        lines = [
            "import { test, expect } from '@playwright/test';",
            "",
            f"test('{safe_name}', async ({{ page }}) => {{",
        ]

        if base_url:
            lines.append(f"  // Base URL provided")
            lines.append(f"  await page.goto('{base_url}');")
            
        for idx, step in enumerate(steps):
            action = step.get("action", "")
            selector = step.get("selector", "")
            value = step.get("value", "")
            
            lines.append(f"  // Step {idx + 1}: {action} {selector if selector else ''}")
            
            if action == "goto":
                lines.append(f"  await page.goto('{value}');")
            elif action == "click":
                lines.append(f"  await page.locator('{selector}').click();")
            elif action == "fill":
                # handle escaping
                safe_val = str(value).replace("'", "\\'")
                lines.append(f"  await page.locator('{selector}').fill('{safe_val}');")
            elif action == "press":
                lines.append(f"  await page.locator('{selector}').press('{value}');")
            elif action == "assert_visible":
                lines.append(f"  await expect(page.locator('{selector}')).toBeVisible();")
            elif action == "assert_text":
                safe_val = str(value).replace("'", "\\'")
                lines.append(f"  await expect(page.locator('{selector}')).toHaveText('{safe_val}');")
            elif action == "assert_url":
                lines.append(f"  await expect(page).toHaveURL(/{value}/);")
            elif action == "hover":
                lines.append(f"  await page.locator('{selector}').hover();")
            else:
                lines.append(f"  // WARNING: Unknown action '{action}'")

        lines.append("});")
        lines.append("")
        
        return "\n".join(lines)
