import { defineConfig } from 'vitepress';

const DESCRIPTION =
  'OptiGate is a self-hosted MCP gateway with token-sparing tool retrieval for LLM tools. One endpoint for all your MCP servers, with optional decision-model reranking.';

// NOTE: project page → base path must match the repo name. If you switch
// to a custom domain, change base to '/'.
export default defineConfig({
  lang: 'en-US',
  title: 'OptiGate',
  description: DESCRIPTION,
  base: '/optigate/',
  head: [
    ['meta', { name: 'description', content: DESCRIPTION }],
    ['meta', { name: 'keywords', content: 'MCP gateway, Model Context Protocol, token-sparing, self-hosted LLM tools, MCP registry, decision model reranking, Jev, OpenRouter, AI agent tooling' }],
    ['meta', { property: 'og:title', content: 'OptiGate — Self-Hosted MCP Gateway' }],
    ['meta', { property: 'og:description', content: DESCRIPTION }],
    ['meta', { property: 'og:type', content: 'website' }],
  ],
  themeConfig: {
    logo: '⚡',
    siteTitle: 'OptiGate',
    nav: [
      { text: 'Guide', link: '/installation' },
      { text: 'Decision Model', link: '/decision-model' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'GitHub', link: 'https://github.com/NinjaEde/optigate' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'What is OptiGate?', link: '/' },
          { text: 'Installation', link: '/installation' },
          { text: 'Connecting clients', link: '/clients' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Decision-model reranking', link: '/decision-model' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/NinjaEde/optigate' },
    ],
    footer: {
      message: 'MIT licensed · Self-hosted MCP gateway with token-sparing tool retrieval',
      copyright: 'OptiGate contributors',
    },
    search: { provider: 'local' },
  },
});
