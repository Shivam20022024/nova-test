"""
CRUD transactions service for Projects, Suites, and Test Cases.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from models.db_models import Project, Suite, TestCase


# ── Projects ─────────────────────────────────────────────────────────────────

def create_project(db: Session, name: str, description: Optional[str] = None, owner_id: Optional[int] = None) -> Project:
    project = Project(name=name, description=description, owner_id=owner_id)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def get_projects(db: Session) -> List[Project]:
    return db.query(Project).all()


def get_project_by_id(db: Session, project_id: int) -> Optional[Project]:
    return db.query(Project).filter(Project.id == project_id).first()


def delete_project(db: Session, project_id: int) -> bool:
    project = get_project_by_id(db, project_id)
    if project:
        db.delete(project)
        db.commit()
        return True
    return False


# ── Suites ───────────────────────────────────────────────────────────────────

def create_suite(db: Session, project_id: int, name: str, description: Optional[str] = None) -> Suite:
    suite = Suite(project_id=project_id, name=name, description=description)
    db.add(suite)
    db.commit()
    db.refresh(suite)
    return suite


def get_suites(db: Session, project_id: Optional[int] = None) -> List[Suite]:
    query = db.query(Suite)
    if project_id is not None:
        query = query.filter(Suite.project_id == project_id)
    return query.all()


def get_suite_by_id(db: Session, suite_id: int) -> Optional[Suite]:
    return db.query(Suite).filter(Suite.id == suite_id).first()


def delete_suite(db: Session, suite_id: int) -> bool:
    suite = get_suite_by_id(db, suite_id)
    if suite:
        db.delete(suite)
        db.commit()
        return True
    return False


# ── Test Cases ───────────────────────────────────────────────────────────────

def create_test_case(db: Session, suite_id: int, name: str, steps: List[Dict[str, Any]], description: Optional[str] = None) -> TestCase:
    test_case = TestCase(suite_id=suite_id, name=name, steps=steps, description=description)
    db.add(test_case)
    db.commit()
    db.refresh(test_case)
    return test_case


def get_test_cases(db: Session, suite_id: Optional[int] = None) -> List[TestCase]:
    query = db.query(TestCase)
    if suite_id is not None:
        query = query.filter(TestCase.suite_id == suite_id)
    return query.all()


def get_test_case_by_id(db: Session, case_id: int) -> Optional[TestCase]:
    return db.query(TestCase).filter(TestCase.id == case_id).first()


def update_test_case(db: Session, case_id: int, steps: List[Dict[str, Any]], name: Optional[str] = None, description: Optional[str] = None) -> Optional[TestCase]:
    case = get_test_case_by_id(db, case_id)
    if case:
        case.steps = steps
        if name:
            case.name = name
        if description:
            case.description = description
        db.commit()
        db.refresh(case)
        return case
    return None


def delete_test_case(db: Session, case_id: int) -> bool:
    case = get_test_case_by_id(db, case_id)
    if case:
        db.delete(case)
        db.commit()
        return True
    return False
