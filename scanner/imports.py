#!/usr/bin/env python3
"""Stage 5 (python): PY-001, PY-002, PY-003, PY-005, PY-006 with the standard-library ast module only.

Usage: imports.py <bundle-dir> <runtime-manifest.json>
Prints a JSON array of {rule, file, line, message}. Bundle code is parsed, never imported or executed.
PY-004 (packaging files) is decided by checks.ts from file names. Severities come from policy.ts.
"""
import ast
import json
import os
import re
import sys

DENY_MODULES = {"subprocess", "socket", "ctypes", "pickle", "marshal", "importlib", "multiprocessing"}
DENY_BUILTINS = {"eval", "exec", "__import__", "compile"}
DENY_OS_ATTR = re.compile(r"^(system|exec\w*|fork\w*|spawn\w*|posix_spawn\w*|popen)$")
WARN_MODULES = {"threading", "asyncio", "concurrent"}
PATH_WRITERS = {"write_text", "write_bytes", "touch", "mkdir", "unlink", "rmdir", "rename", "replace"}
TMP = "/tmp"


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: imports.py <bundle-dir> <runtime-manifest.json>\n")
        return 2
    if not hasattr(sys, "stdlib_module_names"):
        sys.stderr.write("imports.py needs Python 3.10+ (sys.stdlib_module_names)\n")
        return 2
    bundle, manifest_path = argv[1], argv[2]
    with open(manifest_path, encoding="utf-8") as fh:
        runtime = json.load(fh)
    allowed = set(sys.stdlib_module_names) | set(runtime.get("modules", [])) | local_modules(bundle)
    findings = []
    for rel in sorted(py_files(bundle)):
        findings.extend(check_file(bundle, rel, allowed))
    json.dump(findings, sys.stdout)
    return 0


def py_files(bundle):
    for root, _dirs, files in os.walk(bundle):
        for name in files:
            if name.endswith(".py"):
                yield os.path.relpath(os.path.join(root, name), bundle).replace(os.sep, "/")


def local_modules(bundle):
    names = set()
    for entry in os.listdir(bundle):
        path = os.path.join(bundle, entry)
        if entry.endswith(".py") and os.path.isfile(path):
            names.add(entry[:-3])
        elif os.path.isdir(path) and os.path.isfile(os.path.join(path, "__init__.py")):
            names.add(entry)
    return names


def check_file(bundle, rel, allowed):
    with open(os.path.join(bundle, rel), "rb") as fh:
        source = fh.read()
    try:
        tree = ast.parse(source, filename=rel)
    except (SyntaxError, ValueError) as err:
        line = getattr(err, "lineno", 0) or 0
        return [finding("PY-006", rel, line, "file cannot be parsed (%s); imports cannot be verified" % err.msg if hasattr(err, "msg") else str(err))]
    visitor = Visitor(rel, allowed)
    visitor.visit(tree)
    return visitor.findings


def finding(rule, file, line, message):
    return {"rule": rule, "file": file, "line": int(line or 0), "message": message}


class Visitor(ast.NodeVisitor):
    def __init__(self, rel, allowed):
        self.rel = rel
        self.allowed = allowed
        self.findings = []
        self.os_names = set()        # names bound to the os module
        self.os_funcs = {}           # local name -> os attribute (from os import system as s)
        self.path_ctors = set()      # names bound to pathlib.Path / PurePath
        self.pathlib_names = set()   # names bound to the pathlib module
        self.tempfile_names = set()  # names bound to the tempfile module
        self.consts = {}             # module-level NAME = "literal"

    def add(self, rule, node, message):
        self.findings.append(finding(rule, self.rel, getattr(node, "lineno", 0), message))

    def check_module(self, top, node):
        if top not in self.allowed:
            self.add("PY-001", node, "import of %r is outside the standard library and the python-1 runtime" % top)
        if top in DENY_MODULES:
            self.add("PY-002", node, "import of %r is not allowed" % top)
        if top in WARN_MODULES:
            self.add("PY-005", node, "%r is allowed but noted for the approver" % top)

    def visit_Import(self, node):
        for alias in node.names:
            top = alias.name.split(".")[0]
            self.check_module(top, node)
            bound = alias.asname or top
            if top == "os":
                self.os_names.add(bound)
            elif top == "pathlib":
                self.pathlib_names.add(bound)
            elif top == "tempfile":
                self.tempfile_names.add(bound)

    def visit_ImportFrom(self, node):
        if node.level and node.level > 0:
            return  # relative import: local to the bundle
        top = (node.module or "").split(".")[0]
        self.check_module(top, node)
        for alias in node.names:
            bound = alias.asname or alias.name
            if top == "os":
                if DENY_OS_ATTR.match(alias.name):
                    self.add("PY-002", node, "os.%s is not allowed" % alias.name)
                self.os_funcs[bound] = alias.name
            elif top == "pathlib" and alias.name in ("Path", "PurePath", "PosixPath"):
                self.path_ctors.add(bound)

    def visit_Assign(self, node):
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            self.consts[node.targets[0].id] = node.value.value
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            if node.id in DENY_BUILTINS:
                self.add("PY-002", node, "%s() is not allowed" % node.id)
            elif node.id in self.os_funcs and DENY_OS_ATTR.match(self.os_funcs[node.id]):
                self.add("PY-002", node, "os.%s is not allowed" % self.os_funcs[node.id])

    def visit_Attribute(self, node):
        if isinstance(node.value, ast.Name) and node.value.id in self.os_names and DENY_OS_ATTR.match(node.attr):
            self.add("PY-002", node, "os.%s is not allowed" % node.attr)
        self.generic_visit(node)

    def visit_Call(self, node):
        func = node.func
        if isinstance(func, ast.Name) and func.id == "open":
            self.check_open(node, self.arg(node, 0, "file"), self.arg(node, 1, "mode"))
        elif isinstance(func, ast.Attribute):
            receiver = self.path_literal(func.value)
            if receiver is not None and func.attr in PATH_WRITERS:
                self.check_path(node, receiver, "Path(...).%s" % func.attr)
            elif receiver is not None and func.attr == "open":
                self.check_open(node, func.value, self.arg(node, 0, "mode"))
        self.generic_visit(node)

    @staticmethod
    def arg(node, index, keyword):
        for kw in node.keywords:
            if kw.arg == keyword:
                return kw.value
        return node.args[index] if len(node.args) > index else None

    def check_open(self, node, path_expr, mode_expr):
        if mode_expr is None:
            return  # default mode "r"
        if not (isinstance(mode_expr, ast.Constant) and isinstance(mode_expr.value, str)):
            self.add("PY-003", node, "open() with a non-literal mode; cannot verify it is read-only")
            return
        if not any(ch in mode_expr.value for ch in "wax+"):
            return
        self.check_path(node, self.path_literal(path_expr) if path_expr is not None else None, "open(..., %r)" % mode_expr.value)

    def check_path(self, node, path, what):
        if path is None:
            self.add("PY-003", node, "%s with a path that is not a literal; cannot verify it is under %s" % (what, TMP))
        elif not (path == TMP or path.startswith(TMP + "/")):
            self.add("PY-003", node, "%s writes outside %s" % (what, TMP))

    def path_literal(self, expr):
        """Best-effort literal path for an expression; None when it cannot be determined statically."""
        if expr is None:
            return None
        if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
            return expr.value
        if isinstance(expr, ast.Name):
            return self.consts.get(expr.id)
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Div):
            return self.path_literal(expr.left)
        if isinstance(expr, ast.Call):
            func = expr.func
            if isinstance(func, ast.Name) and func.id in self.path_ctors:
                return self.path_literal(expr.args[0]) if expr.args else None
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                if func.value.id in self.pathlib_names and func.attr in ("Path", "PurePath", "PosixPath"):
                    return self.path_literal(expr.args[0]) if expr.args else None
                if func.value.id in self.tempfile_names:
                    return TMP
                if func.value.id == "os" and func.attr == "path":
                    return None
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute):
                base = func.value
                if isinstance(base.value, ast.Name) and base.value.id in self.os_names and base.attr == "path" and func.attr == "join":
                    return self.path_literal(expr.args[0]) if expr.args else None
        return None


if __name__ == "__main__":
    sys.exit(main(sys.argv))
