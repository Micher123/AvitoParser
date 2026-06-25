"""
HTTP-клиент с User-Agent заголовками, имитирующими браузер.
"""
import requests
from typing import Any, Dict, Optional


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)

DEFAULT_SEC_CH_UA = (
    '"Not)A;Brand";v="8", "Chromium";v="138", "Brave";v="138"'
)


def spy_fetch(
    url: str,
    options: Optional[Dict[str, Any]] = None,
) -> requests.Response:
    """
    Выполняет HTTP-запрос с подменой User-Agent.
    Аналог spyFetch из оригинального TypeScript-проекта.
    """
    method = "GET"
    headers: Dict[str, str] = {
        "user-agent": DEFAULT_USER_AGENT,
        "sec-ch-ua": DEFAULT_SEC_CH_UA,
    }
    data = None
    params = None
    timeout = 30
    cookies = None

    if options:
        method = options.get("method", "GET").upper()
        if "headers" in options and options["headers"]:
            user_headers = options["headers"]
            headers.update(user_headers)
        if "body" in options and options["body"]:
            data = options["body"]
        if "params" in options:
            params = options["params"]
        if "timeout" in options:
            timeout = options["timeout"]
        if "cookies" in options:
            cookies = options["cookies"]

    return requests.request(
        method=method,
        url=url,
        headers=headers,
        data=data,
        params=params,
        timeout=timeout,
        cookies=cookies,
    )