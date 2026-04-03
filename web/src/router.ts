import { createRouter, createWebHistory } from 'vue-router'
import HomePage from './views/HomePage.vue'
import GraphPage from './views/GraphPage.vue'
import DocPage from './views/DocPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/graph/:path(.*)', name: 'graph', component: GraphPage },
    { path: '/page/:path(.*)', name: 'page', component: DocPage },
  ],
})

export default router
