import os
import json
from typing import List, Dict, Any
from models.db_models import SiteMap, DiscoveredFlow
from sqlalchemy.orm import Session
from utils.logger import get_logger

logger = get_logger("autonomous_generator")

class AutonomousGenerator:
    def __init__(self):
        try:
            from openai import OpenAI
            api_key = os.getenv("OPENAI_API_KEY")
            self.client = OpenAI(api_key=api_key) if api_key else None
        except Exception as e:
            logger.error(f"Failed to init OpenAI: {e}")
            self.client = None

    def analyze_sitemaps(self, project_id: int, sitemaps: List[SiteMap], db: Session) -> List[DiscoveredFlow]:
        if not self.client:
            raise ValueError("OpenAI client not available.")

        # Aggregate sitemap data
        aggregated = []
        for sm in sitemaps:
            aggregated.append({
                "url": sm.url,
                "title": sm.page_title,
                "elements": sm.metadata_json
            })

        system_prompt = """
        You are an AI QA Architect. Analyze the provided sitemap and discovered elements.
        Identify the critical user flows (e.g. Auth, Checkout, Settings, Search, CRUD operations).
        Output a JSON array of objects representing these flows.
        Format:
        [
            {
                "name": "Login Flow",
                "description": "User logs in with credentials",
                "flow_type": "Auth",
                "generated_steps": [
                    {"action": "goto", "url": "/login"},
                    {"action": "fill", "selector": "input[type='email']", "value": "test@test.com"},
                    {"action": "fill", "selector": "input[type='password']", "value": "password123"},
                    {"action": "click", "selector": "button[type='submit']"},
                    {"action": "assert_url", "value": "/dashboard"}
                ]
            }
        ]
        Respond ONLY with valid JSON.
        """

        user_message = f"Site Data:\n{json.dumps(aggregated, indent=2)}"

        try:
            response = self.client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message}
                ],
                temperature=0.1
            )
            content = (response.choices[0].message.content or "").strip()
            
            # Clean markdown JSON formatting if present
            if content.startswith("```json"):
                content = content[7:-3]
            elif content.startswith("```"):
                content = content[3:-3]

            flows_data = json.loads(content.strip())
            
            discovered_flows = []
            for flow in flows_data:
                db_flow = DiscoveredFlow(
                    project_id=project_id,
                    name=flow.get("name", "Unknown Flow"),
                    description=flow.get("description", ""),
                    flow_type=flow.get("flow_type", "General"),
                    generated_steps=flow.get("generated_steps", [])
                )
                db.add(db_flow)
                discovered_flows.append(db_flow)
            
            db.commit()
            return discovered_flows
            
        except Exception as e:
            logger.error(f"Failed to generate autonomous flows: {e}")
            db.rollback()
            raise
