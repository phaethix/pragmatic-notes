import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'pragmatic-notes',
  description: '务实、简洁的个人博客，记录技术实践与日常思考。',
  lang: 'zh-CN',
  lastUpdated: true,
  cleanUrls: true,
  base: '/pragmatic-notes/',
  appearance: false,
  themeConfig: {
    siteTitle: 'pragmatic-notes',
    nav: [
      { text: '技术实践', link: '/posts/technical/' },
      { text: '日常思考', link: '/posts/thoughts/' }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/phaethix/pragmatic-notes' }
    ],
    outline: {
      level: [2, 3],
      label: '本页目录'
    },
    lastUpdated: {
      text: '更新于'
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },
    editLink: {
      pattern: 'https://github.com/phaethix/pragmatic-notes/edit/master/docs/:path',
      text: '在 GitHub 上编辑此页'
    },
    sidebar: {
      '/posts/technical/': [
        {
          text: '技术实践',
          items: [
            { text: '分类首页', link: '/posts/technical/' },
            { text: '从一个能用的博客开始', link: '/posts/technical/first-note' }
          ]
        }
      ],
      '/posts/thoughts/': [
        {
          text: '日常思考',
          items: [
            { text: '分类首页', link: '/posts/thoughts/' }
          ]
        }
      ],
      '/posts/': [
        {
          text: '全部文章',
          items: [
            { text: '全部文章', link: '/posts/' },
            { text: '技术实践', link: '/posts/technical/' },
            { text: '日常思考', link: '/posts/thoughts/' }
          ]
        }
      ]
    },
    footer: {
      message: '务实记录，持续整理。',
      copyright: 'Copyright © 2026 phaethix'
    }
  }
})
