import axios from "axios"

axios.defaults.env = { ...axios.defaults.env, Request: null, Response: null }
