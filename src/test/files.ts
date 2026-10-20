/** Smallest valid JPEG header + filler, enough for the type check. */
export const tinyJpeg = (size = 64) => {
  const buf = Buffer.alloc(size, 0);
  buf.set([0xff, 0xd8, 0xff, 0xe0]);
  return buf;
};
