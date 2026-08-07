/** Sequential big-endian buffer reader used by the codecs. */
export class Reader {
  private readonly buf: Buffer;
  public offset: number;
  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }
  get remaining() {
    return this.buf.length - this.offset;
  }
  u8() { return this.buf.readUInt8(this.offset++); }
  u16() { const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.offset); this.offset += 4; return v; }
  i16() { const v = this.buf.readInt16BE(this.offset); this.offset += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.offset); this.offset += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.offset); this.offset += 8; return v; }
  bytes(n: number) { const v = this.buf.subarray(this.offset, this.offset + n); this.offset += n; return v; }
}
