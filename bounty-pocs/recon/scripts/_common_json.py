# _common_json.py
import json, datetime, re, os

def to_jsonable(x):
    if isinstance(x, (datetime.date, datetime.datetime)):
        return x.isoformat()
    if isinstance(x, dict):
        return {k: to_jsonable(v) for k, v in x.items()}
    if isinstance(x, list):
        return [to_jsonable(v) for v in x]
    return x

_num_cleaner = re.compile(r'[^0-9eE\+\-\.]')

def to_float_safe(v):
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = _num_cleaner.sub('', str(v))
    try:
        return float(s)
    except ValueError:
        return 0.0

def dump_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_jsonable(obj), f, indent=2, allow_nan=False, ensure_ascii=False)

def load_json(path, default):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default
