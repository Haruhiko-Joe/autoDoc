import { createRouter, createWebHistory } from 'vue-router'
import RunListPage from './views/RunListPage.vue'
import RunDetailPage from './views/RunDetailPage.vue'
import GeneratePage from './views/GeneratePage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'runs', component: RunListPage },
    { path: '/generate', name: 'generate', component: GeneratePage },
    { path: '/run/:project', name: 'detail', component: RunDetailPage },
  ],
})

export default router
