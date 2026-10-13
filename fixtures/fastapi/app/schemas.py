from typing import Optional
from pydantic import BaseModel


class ItemCreate(BaseModel):
    name: str
    price: float
    description: Optional[str] = None
