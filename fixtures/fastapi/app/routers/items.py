from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.schemas import ItemCreate
from app.models import Item
from app.deps import get_db, get_current_user

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/{item_id}")
def read_item(item_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Fetch a single item."""
    return db.query(Item).filter(Item.id == item_id).first()


@router.post("/")
def create_item(item: ItemCreate, db: Session = Depends(get_db)):
    obj = Item(**item.dict())
    db.add(obj)
    db.commit()
    return obj
