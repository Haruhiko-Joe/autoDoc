import { createRouter, createWebHistory } from 'vue-router'
import RunListPage from './views/RunListPage.vue'
import RunDetailPage from './views/RunDetailPage.vue'
import GeneratePage from './views/GeneratePage.vue'
import ValidatePage from './views/ValidatePage.vue'
import ManualValidatePage from './views/ManualValidatePage.vue'
import AblationPage from './views/AblationPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'runs', component: RunListPage },
    { path: '/ablation', name: 'ablation', component: AblationPage },
    { path: '/generate', name: 'generate', component: GeneratePage },
    { path: '/validate', name: 'validate', component: ValidatePage },
    { path: '/manual-validate', name: 'manual-validate', component: ManualValidatePage },
    { path: '/run/:project/:runId', name: 'detail', component: RunDetailPage },
    { path: '/run/:project', redirect: to => ({ name: 'detail', params: { project: to.params.project, runId: 'latest' } }) },
  ],
})

export default router
