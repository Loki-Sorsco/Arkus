from fastapi import FastAPI
from app.routers import items

app = FastAPI()
app.include_router(items.router, prefix="/api")


@app.get("/health")
def health():
    """Liveness probe."""
    return {"ok": True}
