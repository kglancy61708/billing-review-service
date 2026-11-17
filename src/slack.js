'use strict';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function slackClient({ token, channel }) {
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
  if (!channel) throw new Error('SLACK_CHANNEL_ID is not set');

  async function call(method, body, asJson = true) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': asJson ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      },
      body: asJson ? JSON.stringify(body) : new URLSearchParams(body),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`Slack ${method} failed: ${j.error}${j.needed ? ` (needed scope: ${j.needed})` : ''}`);
    return j;
  }

  return {
    async postMessage(text) {
      return call('chat.postMessage', { channel, text, unfurl_links: false });
    },
    // Uploads a file and shares it to the channel with `comment` as the message text.
    async uploadFile({ filename, buffer, comment }) {
      const up = await call('files.getUploadURLExternal', { filename, length: String(buffer.length) }, false);
      const put = await fetch(up.upload_url, { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: buffer });
      if (!put.ok) throw new Error(`Slack file bytes upload failed: HTTP ${put.status}`);
      return call('files.completeUploadExternal', {
        files: [{ id: up.file_id, title: filename.replace(/\.xlsx$/i, '') }],
        channel_id: channel,
        initial_comment: comment,
      });
    },
  };
}

module.exports = { slackClient };
