import type { FastifyPluginAsync } from 'fastify';
import { createReadStream } from 'node:fs';
import type { AttachmentService } from '../attachments/service.ts';

export const attachmentRoutes: FastifyPluginAsync<{
  attachments: AttachmentService;
}> = async (app, { attachments }) => {
  app.addContentTypeParser(
    'application/offset+octet-stream',
    (_request, _payload, done) => done(null),
  );
  let active = 0;
  for (const url of ['/uploads', '/uploads/:id']) {
    app.route({
      url,
      method: ['POST', 'HEAD', 'PATCH', 'OPTIONS'],
      handler: async (req, reply) => {
        if (active >= 4)
          return reply
            .code(429)
            .send({
              error: { message: 'Upload slots are busy. Retry shortly.' },
            });
        const id = (req.params as { id?: string }).id;
        if (id && attachments.active.has(id))
          return reply
            .code(409)
            .send({ error: { message: 'Upload is busy. Retry shortly.' } });
        active++;
        if (id) attachments.active.add(id);
        reply.hijack();
        try {
          await attachments.tus.handle(req.raw, reply.raw);
        } finally {
          active--;
          if (id) attachments.active.delete(id);
        }
      },
    });
  }
  app.get<{ Params: { id: string } }>('/attachments/:id', async (req) => ({
    data: attachments.get(req.params.id),
  }));
  app.post<{ Params: { id: string } }>(
    '/attachments/:id/complete',
    async (req) => ({ data: await attachments.finalize(req.params.id) }),
  );
  app.delete<{ Params: { id: string } }>('/attachments/:id', async (req) => {
    await attachments.remove(req.params.id);
    return { data: { removed: true } };
  });
  app.get<{ Params: { id: string } }>(
    '/attachments/:id/preview',
    async (req, reply) => {
      const asset = attachments.get(req.params.id);
      if (asset.state !== 'ready' || !asset.mime.startsWith('image/'))
        return reply
          .code(404)
          .send({ error: { message: 'Preview unavailable.' } });
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(attachments.path(asset.id) + '.preview.png'));
    },
  );
  app.get<{ Params: { id: string } }>(
    '/attachments/:id/content',
    async (req, reply) => {
      const asset = attachments.get(req.params.id);
      if (asset.state !== 'ready')
        return reply
          .code(409)
          .send({ error: { message: 'Attachment is not ready.' } });
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header(
          'Content-Disposition',
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
        )
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(createReadStream(attachments.path(asset.id)));
    },
  );
};
