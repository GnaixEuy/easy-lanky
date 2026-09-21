// Parse only visible text and image keys; resource contents remain untrusted data.
export function messageContent(
  type: string,
  raw: string,
): { text: string; imageKeys: string[] } {
  const value = JSON.parse(raw);
  if (type === "text" && typeof value.text === "string")
    return { text: value.text, imageKeys: [] };
  if (type === "image" && typeof value.image_key === "string")
    return { text: "[图片]", imageKeys: [value.image_key] };
  if (type !== "post") throw new Error("unsupported_message_content");
  const post = value.content
    ? value
    : (value.zh_cn ?? value.en_us ?? Object.values(value)[0]);
  if (!post || !Array.isArray(post.content)) throw new Error("invalid_post");
  const text: string[] = typeof post.title === "string" ? [post.title] : [];
  const imageKeys: string[] = [];
  for (const row of post.content) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (
        ["text", "a", "md"].includes(node.tag) &&
        typeof node.text === "string"
      )
        text.push(node.text);
      if (node.tag === "at") text.push(node.user_name ?? "[提及成员]");
      if (node.tag === "img" && typeof node.image_key === "string")
        imageKeys.push(node.image_key);
    }
  }
  return { text: text.join("\n") || "[图片]", imageKeys };
}
export interface MessageContext {
  text: string;
  images: Buffer[];
}
export function imageExtension(data: Buffer): string {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "jpg";
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return "gif";
  if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  )
    return "webp";
  throw new Error("unsupported_image_format");
}
