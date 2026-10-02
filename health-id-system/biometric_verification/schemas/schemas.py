from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
from typing import Literal

ChangeType = Literal["initial", "update", "tune", "hotfix", "rollback"]

class CreateModelVersionRequest(BaseModel):
    config: Dict[str, Any] = Field(
        ...,
        description="JSON-конфигурация модели (параметры детекции, пороги и т.п.)"
    )
    change_type: ChangeType = Field(
        ...,
        description="Тип изменения: initial (первая версия), update, tune и др."
    )
    change_description: str = Field(
        ...,
        description="Человекочитаемое описание изменений для аудита"
    )
    parent_version_id: Optional[str] = Field(
        None,
        description="UUID родительской версии. Если не указан — берётся последняя активная."
    )
    force_active: bool = Field(
        False,
        description="Принудительно сделать версию активной (осторожно: может быть только одна активная)"
    )
    created_by: str = Field(
        "api_user",
        description="Пользователь, инициировавший создание версии"
    )

    class Config:
        extra = "forbid"
