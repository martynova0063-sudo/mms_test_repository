{ pkgs }: {
  deps = [
    pkgs.python312
    pkgs.python312Packages.fastapi
    pkgs.python312Packages.uvicorn
    pkgs.python312Packages.sqlalchemy
    pkgs.python312Packages.alembic
    pkgs.python312Packages.pydantic
    pkgs.python312Packages.pyyaml
    pkgs.python312Packages.numpy
    pkgs.python312Packages.scipy
    pkgs.python312Packages.httpx
    pkgs.python312Packages.pandas
  ];
}
