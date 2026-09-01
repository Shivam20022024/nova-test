import os
import json
from typing import Dict, Any, List
from utils.logger import get_logger

logger = get_logger("bug_classifier")

class BugClassifier:
    def __init__(self):
        try:
            from openai import OpenAI
            api_key = os.getenv("OPENAI_API_KEY")
            self.client = OpenAI(api_key=api_key) if api_key else None
        except Exception as e:
            logger.error(f"Failed to init OpenAI for Bug Classifier: {e}")
            self.client = None

    def classify_failure(self, step_index: int, action: str, error_msg: str, console_logs: List[str], network_failures: List[str]) -> Dict[str, Any]:
        """
        Classifies a test failure into a structured bug report.
        """
        if not self.client:
            return {
                "severity": "Unknown",
                "title": f"Failure at step {step_index}",
                "description": error_msg
            }

        system_prompt = """
        You are a Senior QA Engineer. Analyze the test failure details provided.
        Categorize the severity into exactly one of: Critical, High, Medium, Low.
        Output ONLY a JSON object with this exact structure:
        {
            "severity": "Critical|High|Medium|Low",
            "title": "Short descriptive title of the bug",
            "description": "Detailed explanation of what failed, including hints from console logs or network if relevant",
            "suggested_fix": "A highly probable fix for developers"
        }
        """

        user_message = json.dumps({
            "step_index": step_index,
            "failed_action": action,
            "error_msg": error_msg,
            "console_logs": console_logs[-10:], # last 10 logs
            "network_failures": network_failures[-5:]
        }, indent=2)

        try:
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message}
                ],
                temperature=0.0
            )
            content = (response.choices[0].message.content or "").strip()
            
            if content.startswith("```json"):
                content = content[7:-3]
            elif content.startswith("```"):
                content = content[3:-3]

            return json.loads(content.strip())
        except Exception as e:
            logger.error(f"LLM Bug Classification failed: {e}")
            return {
                "severity": "Unknown",
                "title": f"Failure at step {step_index}",
                "description": error_msg
            }
