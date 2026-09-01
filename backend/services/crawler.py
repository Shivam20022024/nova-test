import asyncio
from typing import Set, Dict, Any, List
from urllib.parse import urljoin, urlparse
from playwright.async_api import async_playwright
from sqlalchemy.orm import Session
from models.db_models import SiteMap
from utils.logger import get_logger

logger = get_logger("crawler")

async def crawl_website(base_url: str, project_id: int, db: Session, max_depth: int = 2) -> List[Dict[str, Any]]:
    visited: Set[str] = set()
    queue: List[tuple[str, int]] = [(base_url, 0)]
    domain = urlparse(base_url).netloc
    results = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(ignore_https_errors=True)
        page = await context.new_page()

        while queue:
            current_url, depth = queue.pop(0)
            if current_url in visited or depth > max_depth:
                continue

            visited.add(current_url)
            logger.info(f"[CRAWLER] Visiting {current_url} (depth {depth})")

            try:
                await page.goto(current_url, wait_until="domcontentloaded", timeout=15000)
                await page.wait_for_timeout(2000)

                # Extract metadata
                title = await page.title()
                
                # Extract interactable elements
                links = await page.evaluate('''() => {
                    return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
                }''')
                
                buttons = await page.evaluate('''() => {
                    return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
                        .map(b => b.innerText || b.value || b.id || b.className).filter(t => t.trim().length > 0);
                }''')
                
                inputs = await page.evaluate('''() => {
                    return Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
                        .map(i => ({ name: i.name || i.id, type: i.type || i.tagName.toLowerCase() }));
                }''')

                metadata = {
                    "buttons": list(set(buttons)),
                    "inputs": inputs,
                    "links_count": len(links)
                }

                # Save to DB
                sitemap_entry = SiteMap(
                    project_id=project_id,
                    url=current_url,
                    page_title=title,
                    metadata_json=metadata
                )
                db.add(sitemap_entry)
                db.commit()
                db.refresh(sitemap_entry)
                
                results.append({
                    "url": current_url,
                    "title": title,
                    "metadata": metadata
                })

                # Queue new links
                for link in set(links):
                    parsed_link = urlparse(link)
                    # Stay on same domain
                    if parsed_link.netloc == domain or not parsed_link.netloc:
                        abs_url = urljoin(current_url, link).split('#')[0]
                        if abs_url not in visited:
                            queue.append((abs_url, depth + 1))

            except Exception as e:
                logger.error(f"[CRAWLER] Failed to process {current_url}: {e}")

        await browser.close()
        return results
