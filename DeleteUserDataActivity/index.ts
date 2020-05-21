﻿import * as documentDbUtils from "io-functions-commons/dist/src/utils/documentdb";

import { getRequiredStringEnv } from "io-functions-commons/dist/src/utils/env";

import { documentClient } from "../utils/cosmosdb";

import { createDeleteUserDataActivityHandler } from "./handler";

import { createBlobService } from "azure-storage";
import { MESSAGE_COLLECTION_NAME } from "io-functions-commons/dist/src/models/message";
import { MESSAGE_STATUS_COLLECTION_NAME } from "io-functions-commons/dist/src/models/message_status";
import { NOTIFICATION_COLLECTION_NAME } from "io-functions-commons/dist/src/models/notification";
import {
  NOTIFICATION_STATUS_COLLECTION_NAME,
  NotificationStatusModel
} from "io-functions-commons/dist/src/models/notification_status";
import { PROFILE_COLLECTION_NAME } from "io-functions-commons/dist/src/models/profile";
import { MessageModel } from "./models/message";
import { MessageStatusModel } from "./models/message_status";

import { NotificationModel } from "./models/notification";
import { ProfileModel } from "./models/profile";

const cosmosDbName = getRequiredStringEnv("COSMOSDB_NAME");

const documentDbDatabaseUrl = documentDbUtils.getDatabaseUri(cosmosDbName);

const messageModel = new MessageModel(
  documentClient,
  documentDbUtils.getCollectionUri(
    documentDbDatabaseUrl,
    MESSAGE_COLLECTION_NAME
  ),
  getRequiredStringEnv("MESSAGE_CONTAINER_NAME")
);

const messageStatusModel = new MessageStatusModel(
  documentClient,
  documentDbUtils.getCollectionUri(
    documentDbDatabaseUrl,
    MESSAGE_STATUS_COLLECTION_NAME
  )
);

const notificationModel = new NotificationModel(
  documentClient,
  documentDbUtils.getCollectionUri(
    documentDbDatabaseUrl,
    NOTIFICATION_COLLECTION_NAME
  )
);

const notificationStatusModel = new NotificationStatusModel(
  documentClient,
  documentDbUtils.getCollectionUri(
    documentDbDatabaseUrl,
    NOTIFICATION_STATUS_COLLECTION_NAME
  )
);

const profileModel = new ProfileModel(
  documentClient,
  documentDbUtils.getCollectionUri(
    documentDbDatabaseUrl,
    PROFILE_COLLECTION_NAME
  )
);

const userDataBackupBlobService = createBlobService(
  getRequiredStringEnv("UserDataBackupArchiveStorageConnection")
);

const messageContentBlobService = createBlobService(
  getRequiredStringEnv("MessageContentStorageConnection")
);

const userDataBackupContainerName = getRequiredStringEnv(
  "USER_DATA_BACKUP_CONTAINER_NAME"
);

const activityFunctionHandler = createDeleteUserDataActivityHandler({
  messageContentBlobService,
  messageModel,
  messageStatusModel,
  notificationModel,
  notificationStatusModel,
  profileModel,
  userDataBackupBlobService,
  userDataBackupContainerName
});

export default activityFunctionHandler;
