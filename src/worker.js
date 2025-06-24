addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello') {
      return new Response(JSON.stringify({ message: 'Hello from the Worker!' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Photo Gallery Worker', { status: 200 });
  },
};
