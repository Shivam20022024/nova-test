"""
SQLAlchemy DB declarative models.
"""
from __future__ import annotations

import datetime
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    role = Column(String(50), default="QA Engineer")  # Admin | QA Engineer | Viewer
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    projects = relationship("Project", back_populates="owner", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, index=True, nullable=False)
    description = Column(Text, nullable=True)
    owner_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    # Relationships
    owner = relationship("User", back_populates="projects")
    suites = relationship("Suite", back_populates="project", cascade="all, delete-orphan")
    runs = relationship("TestRun", back_populates="project", cascade="all, delete-orphan")
    schedules = relationship("Schedule", back_populates="project", cascade="all, delete-orphan")


class Suite(Base):
    __tablename__ = "suites"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), index=True, nullable=False)
    description = Column(Text, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="suites")
    test_cases = relationship("TestCase", back_populates="suite", cascade="all, delete-orphan")
    runs = relationship("TestRun", back_populates="suite", cascade="all, delete-orphan")
    schedules = relationship("Schedule", back_populates="suite", cascade="all, delete-orphan")


class TestCase(Base):
    __tablename__ = "test_cases"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), index=True, nullable=False)
    description = Column(Text, nullable=True)
    steps = Column(JSON, nullable=False)  # List of dict steps
    suite_id = Column(Integer, ForeignKey("suites.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    # Relationships
    suite = relationship("Suite", back_populates="test_cases")
    runs = relationship("TestRun", back_populates="test_case", cascade="all, delete-orphan")


class TestRun(Base):
    __tablename__ = "test_runs"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(String(100), index=True, nullable=False)  # Unique execution batch ID
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    suite_id = Column(Integer, ForeignKey("suites.id", ondelete="CASCADE"), nullable=True)
    test_case_id = Column(Integer, ForeignKey("test_cases.id", ondelete="CASCADE"), nullable=True)

    browser = Column(String(50), nullable=False)
    device = Column(String(100), nullable=True)
    environment = Column(String(50), nullable=False, default="Production")
    status = Column(String(50), nullable=False)  # passed | failed | skipped
    duration_ms = Column(Integer, nullable=False, default=0)

    error = Column(Text, nullable=True)
    error_type = Column(String(100), nullable=True)
    screenshot_url = Column(Text, nullable=True)
    video_url = Column(Text, nullable=True)
    trace_url = Column(Text, nullable=True)
    execution_result = Column(JSON, nullable=True)  # Detailed per-step logs and results
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="runs")
    suite = relationship("Suite", back_populates="runs")
    test_case = relationship("TestCase", back_populates="runs")


class Schedule(Base):
    __tablename__ = "schedules"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    cron_expression = Column(String(100), nullable=False)  # e.g., "0 0 * * *" or "daily" / "weekly"
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    suite_id = Column(Integer, ForeignKey("suites.id", ondelete="CASCADE"), nullable=False)
    environment = Column(String(50), nullable=False, default="Production")

    browsers = Column(JSON, nullable=False)  # List of browsers, e.g. ["chromium", "firefox"]
    devices = Column(JSON, nullable=False)  # List of devices, e.g. ["Desktop", "iPhone 13"]
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Relationships
    project = relationship("Project", back_populates="schedules")
    suite = relationship("Suite", back_populates="schedules")


class SiteMap(Base):
    __tablename__ = "sitemaps"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    url = Column(String(2048), nullable=False)
    page_title = Column(String(1024), nullable=True)
    metadata_json = Column(JSON, nullable=True)  # Store discovered forms, links, buttons
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    project = relationship("Project")


class DiscoveredFlow(Base):
    __tablename__ = "discovered_flows"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    flow_type = Column(String(100), nullable=True)  # Auth, Navigation, Checkout, etc.
    generated_steps = Column(JSON, nullable=True)   # Discovered steps before test creation
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    project = relationship("Project")
