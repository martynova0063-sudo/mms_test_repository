# Biometric Verification

Modules 4.1.1 (Face Matching) + 4.1.2 (Liveness Detection).

## Install
```bash
pip install -r requirements.txt
```

## CLI
```bash
python -m biometric_verification.cli verify --photo p.jpg --video v.mp4 --worker w1
python -m biometric_verification.cli face-match --photo p.jpg --video v.mp4
python -m biometric_verification.cli liveness-check --video v.mp4
python -m biometric_verification.cli quality-check --video v.mp4
python -m biometric_verification.cli init-db --dsn "postgresql://..."
python -m biometric_verification.cli register-model --dsn "..." --created-by admin
```
