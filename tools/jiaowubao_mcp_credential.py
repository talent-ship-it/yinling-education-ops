import ctypes
import os
import re
import sys

PROFILE_HOME = "/Users/nixon/.hermes/profiles/insiderleads"
KEYCHAIN = "/Users/nixon/Library/Keychains/login.keychain-db"
SERVICE = b"insiderleads.jiaowubao.mcp"
ACCOUNT = b"insiderlead"


class CredentialError(Exception):
    pass


def read_secret():
    if sys.platform != "darwin" or not sys.flags.isolated or not sys.flags.no_site:
        raise CredentialError("context")
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_bool]
    security.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
    security.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    security.SecKeychainOpen.restype = ctypes.c_int32
    security.SecKeychainFindGenericPassword.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
    ]
    security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
    security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    security.SecKeychainItemFreeContent.restype = ctypes.c_int32
    core.CFRelease.argtypes = [ctypes.c_void_p]
    core.CFRelease.restype = None
    keychain = ctypes.c_void_p()
    data = ctypes.c_void_p()
    length = ctypes.c_uint32()
    if security.SecKeychainSetUserInteractionAllowed(False) != 0:
        raise CredentialError("interaction")
    try:
        if security.SecKeychainOpen(KEYCHAIN.encode(), ctypes.byref(keychain)) != 0:
            raise CredentialError("unavailable")
        status = security.SecKeychainFindGenericPassword(
            keychain, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT,
            ctypes.byref(length), ctypes.byref(data), None,
        )
        if status != 0 or not data.value or not 1 <= length.value <= 4096:
            raise CredentialError("unavailable")
        return ctypes.string_at(data, length.value).decode("ascii")
    finally:
        if data.value:
            security.SecKeychainItemFreeContent(None, data)
        if keychain.value:
            core.CFRelease(keychain)


def main(args):
    if args not in (["--check"], ["--emit-env"]):
        return 2
    if os.environ.get("HERMES_HOME") != PROFILE_HOME:
        return 2
    try:
        value = read_secret()
        if not isinstance(value, str) or not 1 <= len(value) <= 4096:
            raise CredentialError("invalid")
        if re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", value) is None:
            raise CredentialError("invalid")
        if args == ["--emit-env"]:
            sys.stdout.write("INSIDERLEADS_JWB_MCP_TOKEN=" + value + "\n")
        else:
            sys.stdout.write("jiaowubao_mcp_credential=available\n")
        return 0
    except Exception:
        sys.stderr.write("jiaowubao_mcp_credential=unavailable\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
