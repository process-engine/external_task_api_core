import {IIAMService, IIdentity} from '@essential-projects/iam_contracts';

import {ExternalTask, IExternalTaskApi, IExternalTaskRepository} from '@process-engine/external_task_api_contracts';

export class ExternalTaskApiService implements IExternalTaskApi {

  private readonly _externalTaskRepository: IExternalTaskRepository;
  private readonly _iamService: IIAMService;

  constructor(externalTaskRepository: IExternalTaskRepository, iamService: IIAMService) {
    this._externalTaskRepository = externalTaskRepository;
    this._iamService = iamService;
  }

  public async fetchAndLockExternalTasks(identity: IIdentity,
                                         workerId: string,
                                         topicName: string,
                                         maxTasks: number,
                                         longPollingTimeout: number,
                                         lockDuration: number): Promise<Array<ExternalTask>> {

    return this._externalTaskRepository.fetchAndLockExternalTasks(workerId, topicName, maxTasks, longPollingTimeout, lockDuration);
  }

  public async extendLock(identity: IIdentity, workerId: string, externalTaskId: string, additionalDuration: number): Promise<void> {

    return this._externalTaskRepository.extendLock(workerId, externalTaskId, additionalDuration);
  }

  public async handleBpmnError(identity: IIdentity, workerId: string, externalTaskId: string, errorCode: string): Promise<void> {

    return this._externalTaskRepository.handleBpmnError(workerId, externalTaskId, errorCode);
  }

  public async handleServiceError(identity: IIdentity,
                                  workerId: string,
                                  externalTaskId: string,
                                  errorMessage: string,
                                  errorDetails: string): Promise<void> {

    return this._externalTaskRepository.handleServiceError(workerId, externalTaskId, errorMessage, errorDetails);
  }

  public async finishExternalTask(identity: IIdentity, workerId: string, externalTaskId: string, payload: any): Promise<void> {

    return this._externalTaskRepository.finishExternalTask(workerId, externalTaskId, payload);
  }
}
