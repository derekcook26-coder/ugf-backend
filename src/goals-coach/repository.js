async function withTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function notFound(code, message) {
  const error = new Error(message);
  error.statusCode = 404;
  error.code = code;
  return error;
}

function conflict(code, message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

function forbidden(code, message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  return error;
}

module.exports = { conflict, forbidden, notFound, withTransaction };
