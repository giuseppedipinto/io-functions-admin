// eslint-disable @typescript-eslint/no-explicit-any

import { UserDataProcessingChoiceEnum } from "@pagopa/io-functions-commons/dist/generated/definitions/UserDataProcessingChoice";
import { UserDataProcessingStatusEnum } from "@pagopa/io-functions-commons/dist/generated/definitions/UserDataProcessingStatus";
import { UserDataProcessing } from "@pagopa/io-functions-commons/dist/src/models/user_data_processing";
import {
  context,
  mockRaiseEvent,
  mockStartNew
} from "../../__mocks__/durable-functions";
import { aUserDataProcessing } from "../../__mocks__/mocks";
import {
  triggerHandler,
  ProcessableUserDataDelete,
  ProcessableUserDataDeleteAbort,
  ProcessableUserDataDownload
} from "../handler";
import { some } from "fp-ts/lib/Option";
import { TableUtilities } from "azure-storage";
import { NonEmptyString } from "@pagopa/ts-commons/lib/strings";
import * as E from "fp-ts/lib/Either";
import { pipe } from "fp-ts/lib/function";
import { readableReport } from "@pagopa/ts-commons/lib/reporters";

// converts a UserDataProcessing object in a form as it would come from the database
const toUndecoded = (doc: UserDataProcessing) => ({
  ...doc,
  createdAt: doc.createdAt.toISOString(),
  updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : undefined
});

const aProcessableDownload = {
  ...aUserDataProcessing,
  choice: UserDataProcessingChoiceEnum.DOWNLOAD,
  status: UserDataProcessingStatusEnum.PENDING
};

const aProcessableDelete = {
  ...aUserDataProcessing,
  choice: UserDataProcessingChoiceEnum.DELETE,
  status: UserDataProcessingStatusEnum.PENDING
};

const aNonProcessableDownloadWrongStatus = {
  ...aUserDataProcessing,
  choice: UserDataProcessingChoiceEnum.DOWNLOAD,
  status: UserDataProcessingStatusEnum.WIP
};

const aNonProcessableDeleteWrongStatus = {
  ...aUserDataProcessing,
  choice: UserDataProcessingChoiceEnum.DELETE,
  status: UserDataProcessingStatusEnum.WIP
};

const aProcessableDeleteAbort = {
  ...aUserDataProcessing,
  choice: UserDataProcessingChoiceEnum.DELETE,
  status: UserDataProcessingStatusEnum.ABORTED
};

const aFailedUserDataProcessing = {
  ...aUserDataProcessing,
  status: UserDataProcessingStatusEnum.FAILED,
  reason: "any reason" as NonEmptyString
};

const aClosedUserDataProcessing = {
  ...aUserDataProcessing,
  status: UserDataProcessingStatusEnum.CLOSED
};

jest.mock("../../utils/featureFlags", () => ({
  flags: {
    ENABLE_USER_DATA_DELETE: true,
    ENABLE_USER_DATA_DOWNLOAD: true
  }
}));

const eg = TableUtilities.entityGenerator;

const insertEntity = jest.fn<any, any[]>(
  () =>
    ({
      e1: E.right("inserted")
    } as any)
);

const deleteEntity = jest.fn<any, any[]>(
  () =>
    ({
      e1: some("deleted"),
      e2: { statusCode: 200 }
    } as any)
);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("UserDataProcessingTrigger", () => {
  it("should fail on invalid input", async () => {
    const input = "invalid";

    try {
      const handler = triggerHandler(insertEntity, deleteEntity);
      await handler(context, input);
      fail("it should throw");
    } catch (error) {
      expect(mockStartNew).not.toHaveBeenCalled();
    }
  });

  it("should process every processable document", async () => {
    const processableDocs: ReadonlyArray<UserDataProcessing> = [
      aProcessableDownload,
      aProcessableDownload,
      aProcessableDelete
    ];

    const input: ReadonlyArray<any> = [
      ...processableDocs,
      aNonProcessableDownloadWrongStatus,
      aNonProcessableDeleteWrongStatus
    ];

    const handler = triggerHandler(insertEntity, deleteEntity);
    await handler(context, input);

    expect(mockStartNew).toHaveBeenCalledTimes(processableDocs.length);
  });

  it("should process every processable document (with undecoded data)", async () => {
    const processableDocs: ReadonlyArray<UserDataProcessing> = [
      aProcessableDownload,
      aProcessableDownload,
      aProcessableDelete
    ];

    const processableDocsAbort: ReadonlyArray<UserDataProcessing> = [
      aProcessableDeleteAbort,
      aProcessableDeleteAbort
    ];

    const input: ReadonlyArray<any> = [
      ...processableDocs,
      aNonProcessableDownloadWrongStatus,
      ...processableDocsAbort,
      aNonProcessableDeleteWrongStatus
    ].map(toUndecoded);

    const handler = triggerHandler(insertEntity, deleteEntity);
    await handler(context, input);

    expect(mockStartNew).toHaveBeenCalledTimes(processableDocs.length);
    expect(mockRaiseEvent).toHaveBeenCalledTimes(processableDocsAbort.length);
  });
});

describe("ProcessableUserDataDownload", () => {
  it("should map processable download records", () => {
    const result = pipe(
      aProcessableDownload,
      ProcessableUserDataDownload.decode,
      E.isRight
    );
    expect(result).toBe(true);
  });
  it.each`
    name                       | value
    ${"delete wrong status"}   | ${aNonProcessableDeleteWrongStatus}
    ${"download wrong status"} | ${aNonProcessableDownloadWrongStatus}
    ${"processable delete"}    | ${aProcessableDelete}
  `("should not map unprocessable record '$name'", ({ value }) => {
    const result = pipe(value, ProcessableUserDataDownload.decode, E.isLeft);
    expect(result).toBe(true);
  });
});

describe("ProcessableUserDataDelete", () => {
  it("should map processable delete records", () => {
    const result = pipe(
      aProcessableDelete,
      ProcessableUserDataDelete.decode,
      E.isRight
    );
    expect(result).toBe(true);
  });
  it.each`
    name                          | value
    ${"delete wrong status"}      | ${aNonProcessableDeleteWrongStatus}
    ${"download wrong status"}    | ${aNonProcessableDownloadWrongStatus}
    ${"processable download"}     | ${aProcessableDownload}
    ${"processable delete abort"} | ${aProcessableDeleteAbort}
  `("should not map unprocessable record '$name'", ({ value }) => {
    const result = pipe(value, ProcessableUserDataDelete.decode, E.isLeft);
    expect(result).toBe(true);
  });
});

describe("ProcessableUserDataDeleteAbort", () => {
  it("should map processable delete records", () => {
    const result = pipe(
      aProcessableDeleteAbort,
      ProcessableUserDataDeleteAbort.decode,
      E.isRight
    );
    expect(result).toBe(true);
  });
  it.each`
    name                       | value
    ${"delete wrong status"}   | ${aNonProcessableDeleteWrongStatus}
    ${"download wrong status"} | ${aNonProcessableDownloadWrongStatus}
    ${"processable download"}  | ${aProcessableDownload}
    ${"processable delete"}    | ${aProcessableDelete}
  `("should not map unprocessable record '$name'", ({ value }) => {
    const result = pipe(value, ProcessableUserDataDeleteAbort.decode, E.isLeft);
    expect(result).toBe(true);
  });
});

describe("FailedUserDataProcessing", () => {
  it("should process a failed user_data_processing inserting a failed record", async () => {
    const failedUserDataProcessing: ReadonlyArray<UserDataProcessing> = [
      aFailedUserDataProcessing
    ];

    const input: ReadonlyArray<any> = [...failedUserDataProcessing].map(
      toUndecoded
    );

    const handler = triggerHandler(insertEntity, deleteEntity);
    await handler(context, input);

    expect(insertEntity).toBeCalled();
    expect(insertEntity).toBeCalledTimes(1);
    expect(insertEntity).toBeCalledWith({
      PartitionKey: eg.String(failedUserDataProcessing[0].choice),
      RowKey: eg.String(failedUserDataProcessing[0].fiscalCode),
      Reason: eg.String(failedUserDataProcessing[0].reason)
    });
    expect(deleteEntity).not.toBeCalled();
  });
});

describe("ClosedUserDataProcessing", () => {
  it("should process a closed user_data_processing removing a possible failed record", async () => {
    const closedUserDataProcessing: ReadonlyArray<UserDataProcessing> = [
      aClosedUserDataProcessing
    ];

    const input: ReadonlyArray<any> = [...closedUserDataProcessing].map(
      toUndecoded
    );

    const handler = triggerHandler(insertEntity, deleteEntity);
    await handler(context, input);

    expect(deleteEntity).toBeCalled();
    expect(deleteEntity).toBeCalledTimes(1);
    expect(deleteEntity).toBeCalledWith({
      PartitionKey: eg.String(closedUserDataProcessing[0].choice),
      RowKey: eg.String(closedUserDataProcessing[0].fiscalCode)
    });
  });
});
