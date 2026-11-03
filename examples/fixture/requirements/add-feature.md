# 冒烟需求：修复 multiply 并实现 divide

## 背景

`examples/fixture/calc.py` 是 Hugin 框架的冒烟测试模块，目前处于故意失败状态：

- `multiply(a, b)` 返回 `a - b`，应为 `a * b`。
- `divide(a, b)` 尚未实现，但 `test_calc.py` 已经引用。

## 要求

1. 修复 `multiply`，保持函数签名不变。
2. 实现 `divide(a, b)`：
   - 正常情况返回浮点或整数除法结果，`divide(8, 2) == 4`。
   - `b == 0` 时抛 `ZeroDivisionError`，不要返回 `inf` 或 `None`。
3. 不要修改现有测试的断言；如需补测试，只能新增。
4. 不改动其他文件。

## 验收

```bash
python3 -m unittest discover -s examples/fixture -v
```

必须退出码 0，且 6 个测试全部通过。

## 允许修改

- `examples/fixture/calc.py`
- `examples/fixture/test_calc.py`（只允许新增测试）

## 证据

`.hugin/runs/<run>/tasks/T1/handoff.json`
