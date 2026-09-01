from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from models.database import get_db
from models.db_models import SiteMap, DiscoveredFlow, Project
from models.schemas import SiteMapResponse, DiscoveredFlowResponse
from services.crawler import crawl_website
from llm.autonomous_generator import AutonomousGenerator

router = APIRouter(prefix="/api/v1/discovery", tags=["Discovery"])

@router.post("/crawl/{project_id}")
async def start_crawl(project_id: int, base_url: str, max_depth: int = 2, db: Session = Depends(get_db)):
    """
    Start a Playwright crawl to discover URLs, buttons, and forms.
    """
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        results = await crawl_website(base_url, project_id, db, max_depth)
        return {"message": "Crawl completed successfully", "pages_discovered": len(results)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Crawl failed: {str(e)}")


@router.post("/generate-flows/{project_id}", response_model=List[DiscoveredFlowResponse])
async def generate_autonomous_flows(project_id: int, db: Session = Depends(get_db)):
    """
    Analyze crawled sitemaps and use LLM to generate testable user flows.
    """
    sitemaps = db.query(SiteMap).filter(SiteMap.project_id == project_id).all()
    if not sitemaps:
        raise HTTPException(status_code=404, detail="No sitemaps found for this project. Crawl first.")

    generator = AutonomousGenerator()
    try:
        flows = generator.analyze_sitemaps(project_id, sitemaps, db)
        return flows
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")


@router.get("/flows/{project_id}", response_model=List[DiscoveredFlowResponse])
def get_discovered_flows(project_id: int, db: Session = Depends(get_db)):
    """
    Retrieve all auto-discovered flows for a project.
    """
    flows = db.query(DiscoveredFlow).filter(DiscoveredFlow.project_id == project_id).all()
    return flows
