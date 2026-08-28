/** 把异步上传完成的附件追加到当前正文，而不是追加到上传开始时的旧快照。 */
export function appendBodyAttachment(currentBody: string, attachment: string): string {
  return currentBody.trim() === "" ? attachment : currentBody + "\n\n" + attachment;
}
