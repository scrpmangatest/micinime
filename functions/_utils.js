export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
});

export async function assetJson(context, pathname) {
  const response = await context.env.ASSETS.fetch(new Request(new URL(pathname, context.request.url)));
  if (!response.ok) return null;
  return response.json();
}

export function paginate(items, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  return {
    items: items.slice((currentPage - 1) * perPage, currentPage * perPage),
    pagination: { currentPage, totalPages, perPage, hasPrev: currentPage > 1, hasNext: currentPage < totalPages }
  };
}

export function slugFile(slug) {
  return encodeURIComponent(slug).replace(/%2F/gi, '_');
}
