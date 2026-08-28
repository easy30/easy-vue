/**
 * HTTP AOP 装饰器测试 API
 * 
 * 演示如何使用 @api、@post、@get、@json、@form 装饰器
 */

// 导入装饰器
import { api, post, get, json, form } from 'api-aop';

@api("/api/demo")
class DemoApi {
    
    /**
     * POST JSON - 单参数自动推断
     */
    @post("/save")
    saveUser(user) {
        // user 自动作为 JSON body
    }

    /**
     * POST JSON - 显式指定 body 参数
     */
    @post("/update", "data")
    @json
    updateUser(data, token) {
        // data 作为 JSON body，token 作为 URL 参数
    }

    /**
     * POST Form - 全量打平
     */
    @post("/submit")
    @form
    submitForm(name, age, email) {
        // 所有参数都作为 form data
    }

    /**
     * GET 请求
     */
    @get("/list")
    getList(page, size) {
        // 所有参数都作为 query string
    }
}

export const demoApi = new DemoApi();
