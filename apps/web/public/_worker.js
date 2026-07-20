const API_ORIGIN = "https://45-151-122-234.sslip.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (!["GET", "POST", "OPTIONS"].includes(request.method)) {
      return new Response(JSON.stringify({ error: "Método não permitido" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const upstream = new URL(url.pathname + url.search, API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete("host");

    try {
      return await fetch(
        new Request(upstream, {
          method: request.method,
          headers,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : request.body,
          redirect: "manual",
        }),
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "API temporariamente indisponível" }),
        {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  },
};
