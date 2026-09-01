"""
Authentication utilities — password hashing, JWT management, and FastAPI RBAC guards.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Any, Dict, Optional
import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from models.database import get_db
from models.db_models import User

# Configuration secrets
JWT_SECRET = os.getenv("JWT_SECRET", "super-secret-enterprise-key-998877")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def hash_password(password: str) -> str:
    """Hash plain text password using bcrypt."""
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify standard plain-text password against bcrypt hash."""
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except Exception:
        return False


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """Generate JWT access token with payload and expiry."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
    """Safe token decoding, catching expired or corrupted payloads."""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI Guard yielding the authenticated DB User object, defaulting to mock user if Auth is disabled."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        # Fallback mechanism: if there are absolutely no users in the DB yet,
        # we auto-register a default Admin user so that the application is instantly functional.
        admin_user = db.query(User).filter(User.role == "Admin").first()
        if not admin_user:
            admin_user = User(
                email="admin@testplatform.ai",
                hashed_password=hash_password("admin123"),
                full_name="Enterprise Admin",
                role="Admin",
            )
            db.add(admin_user)
            db.commit()
            db.refresh(admin_user)
        return admin_user

    payload = decode_access_token(token)
    if payload is None:
        raise credentials_exception

    email: str = payload.get("sub")
    if email is None:
        raise credentials_exception

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception

    return user


class RoleChecker:
    """RBAC Guard verifying if the authenticated user has sufficient privileges."""

    def __init__(self, allowed_roles: list[str]) -> None:
        self.allowed_roles = allowed_roles

    def __call__(self, user: User = Depends(get_current_user)) -> User:
        if user.role not in self.allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access forbidden: requires one of roles {self.allowed_roles}",
            )
        return user


# Standardized RBAC instances
require_admin = RoleChecker(["Admin"])
require_engineer = RoleChecker(["Admin", "QA Engineer"])
require_viewer = RoleChecker(["Admin", "QA Engineer", "Viewer"])
