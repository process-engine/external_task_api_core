'use strict';

const ExternalTaskApiService = require('./dist/commonjs/index').ExternalTaskApiService;

function registerInContainer(container) {

  container.register('ExternalTaskApiService', ExternalTaskApiService)
    .dependencies('ExternalTaskRepository', 'IamService')
    .singleton();
}

module.exports.registerInContainer = registerInContainer;
