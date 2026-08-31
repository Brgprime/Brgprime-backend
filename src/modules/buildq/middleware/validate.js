import { BuildqError } from '../lib/errors.js';

// Validate req[source] against a Zod schema, reporting failures in the BuildQ
// envelope: { error: { code, message, fields: { "path": "message" } } } — the
// shape the frontend forms already expect for inline field errors.
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const fields = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return next(BuildqError.validation('Please check the highlighted fields.', fields));
  }
  // Express 5 exposes req.query as a getter — assign parsed queries elsewhere.
  if (source === 'query') {
    req.validatedQuery = result.data;
  } else {
    req[source] = result.data;
  }
  next();
};
