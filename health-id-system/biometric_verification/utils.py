import dataclasses
import json
from datetime import datetime, date

def _to_serializable(obj):
    """Преобразует dataclass/объект в dict, пригодный для json.dumps."""
    if dataclasses.is_dataclass(obj):
        return dataclasses.asdict(obj)
    if isinstance(obj, dict):
        return {k: _to_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_serializable(i) for i in obj]
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if hasattr(obj, "__dict__"):
        return {k: _to_serializable(v) for k, v in obj.__dict__.items()}
    return obj

def _to_jsonable(obj):
    """Алиас для совместимости с API."""
    return _to_serializable(obj)
