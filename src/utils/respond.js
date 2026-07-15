// Consistent success envelope: { success: true, data, ...meta }
export function ok(res, data, meta = {}, status = 200) {
  return res.status(status).json({ success: true, data, ...meta });
}

export function created(res, data, meta = {}) {
  return ok(res, data, meta, 201);
}
