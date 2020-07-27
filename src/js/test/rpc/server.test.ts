import { Server } from "../../modules/rpc/server";
import { join } from "path";
import CoprocessorRepository from "../../modules/supervisors/CoprocessorRepository";
import {
  Coprocessor,
  CoprocessorRecordBatch,
  PolicyError,
} from "../../modules/public/Coprocessor";
import { CoprocessorRequest } from "../../modules/domain/CoprocessorRequest";
import CoprocessorFileManager from "../../modules/supervisors/CoprocessorFileManager";
import assert = require("assert");

const sinon = require("sinon");
const net = require("net");
const fakeFileManager = require("../../modules/supervisors/CoprocessorFileManager");

const createCoprocessorRequest = (topic?: string): CoprocessorRequest => {
  const coprocessorRecordBatch = [
    {
      records: [{ value: Buffer.from("Example") }],
      header: {},
    },
  ] as CoprocessorRecordBatch[];
  return new CoprocessorRequest(
    { topic: topic || "topicA" },
    { records: coprocessorRecordBatch },
    "1"
  );
};

const createFakeServer = (afterApply?: (value) => void, fileManagerStub?) => {
  const fakeFolder = join(__dirname);
  const fakeSocket = net.Socket();
  fakeSocket.write = afterApply || (() => {});
  fileManagerStub || sinon.stub(fakeFileManager);
  const createSer = sinon.stub(net, "createServer");
  createSer.value((fn) => fn(fakeSocket));
  const fakeServer = new Server(fakeFolder, fakeFolder, fakeFolder);
  return [fakeServer, fakeSocket];
};

const createMockCoprocessor = (
  globalId: Coprocessor["globalId"] = 1,
  inputTopics: Coprocessor["inputTopics"] = ["topicA"],
  policyError: Coprocessor["policyError"] = PolicyError.SkipOnFailure,
  apply: Coprocessor["apply"] = (record) => undefined
): Coprocessor => ({
  globalId,
  inputTopics,
  policyError,
  apply,
});

describe("Server", function () {
  describe("Given a CoprocessorRequest", function () {
    afterEach(sinon.restore);

    it("shouldn't apply any coprocessor if the repository is empty", function (done) {
      const repository = sinon.spy(
        CoprocessorRepository.prototype,
        "getCoprocessorsByTopics"
      );
      const apply = sinon.spy(Server.prototype, "applyCoprocessor");
      const afterApplyCoprocessor = () => {
        assert(repository.calledOnce);
        assert(apply.calledOnce);
        apply.firstCall.returnValue.then((result) => {
          assert.deepStrictEqual(result, []);
          done();
        });
      };
      const [_, fakeSocket] = createFakeServer(afterApplyCoprocessor);
      fakeSocket.emit("readable", createCoprocessorRequest());
    });

    it(
      "shouldn't apply any Coprocessor if there isn't one defined for the " +
        "CoprocessorRequest's topic",
      function (done) {
        const repository = sinon.stub(
          CoprocessorRepository.prototype,
          "getCoprocessorsByTopics"
        );
        repository.returns(new Map().set("topicB", [createMockCoprocessor()]));
        const apply = sinon.spy(Server.prototype, "applyCoprocessor");
        const [_, fakeSocket] = createFakeServer(() => {
          assert(repository.called);
          assert(repository.getCall(0).returnValue.size > 0);
          assert(
            !repository
              .getCall(0)
              .returnValue.has(coprocessorRequest.getTopic())
          );
          assert(apply.called);
          apply.firstCall.returnValue.then((values) => {
            assert.deepStrictEqual(values, []);
            done();
          });
        });
        const coprocessorRequest = createCoprocessorRequest();
        fakeSocket.emit("readable", coprocessorRequest);
      }
    );

    it(
      "should apply the right Coprocessor for the CoprocessorRequest's " +
        "topic",
      function (done) {
        const repository = sinon.stub(
          CoprocessorRepository.prototype,
          "getCoprocessorsByTopics"
        );
        repository.returns(new Map().set("topicA", [createMockCoprocessor()]));
        const apply = sinon.spy(Server.prototype, "applyCoprocessor");
        const coprocessorRequest = createCoprocessorRequest("topicA");
        const [_, fakeSocket] = createFakeServer(() => {
          assert(repository.called);
          assert.deepStrictEqual(repository.getCall(0).args, []);
          assert(repository.getCall(0).returnValue.size === 1);
          assert(apply.called);
          apply.firstCall.returnValue
            .then((values) => {
              assert.deepStrictEqual(values, [[undefined]]);
              done();
            })
            .catch(done);
        });
        fakeSocket.emit("readable", coprocessorRequest);
      }
    );

    describe("Given an Error when applying the Coprocessor", function () {
      it(
        "should skip the CoprocessorRequest, if ErrorPolicy is " +
          "SkipOnFailure",
        function (done) {
          const repository = sinon.stub(
            CoprocessorRepository.prototype,
            "getCoprocessorsByTopics"
          );
          const badAppyCoprocessor = (record: CoprocessorRecordBatch) =>
            // @ts-ignore
            record.bad.attribute;
          repository.returns(
            new Map().set("topicA", [
              createMockCoprocessor(undefined, null, null, badAppyCoprocessor),
            ])
          );
          const apply = sinon.spy(Server.prototype, "applyCoprocessor");
          const handle = sinon.spy(
            Server.prototype,
            "handleErrorByCoprocessorPolicy"
          );
          const deregister = sinon.spy(
            CoprocessorFileManager.prototype,
            "deregisterCoprocessor"
          );
          sinon
            .stub(CoprocessorFileManager.prototype, "readActiveCoprocessor")
            .returns(Promise.resolve(true));
          const [fakeServer, fakeSocket] = createFakeServer(() => {
            assert(apply.called);
            assert(handle.called);
            assert(!deregister.called);
            fakeServer.closeCoprocessorManager().then(done).catch(done);
          }, true);
          const coprocessorRequest = createCoprocessorRequest("topicA");
          fakeSocket.emit("readable", coprocessorRequest);
        }
      );

      it("should deregister the Coprocessor, if ErrorPolicy is Deregister", function (done) {
        const repository = sinon.stub(
          CoprocessorRepository.prototype,
          "getCoprocessorsByTopics"
        );
        const badApplyCoprocessor = (record: CoprocessorRecordBatch) =>
          // @ts-ignore
          record.bad.attribute;
        repository.returns(
          new Map().set("topicA", [
            createMockCoprocessor(
              undefined,
              null,
              PolicyError.Deregister,
              badApplyCoprocessor
            ),
          ])
        );
        const apply = sinon.spy(Server.prototype, "applyCoprocessor");
        const handle = sinon.spy(
          Server.prototype,
          "handleErrorByCoprocessorPolicy"
        );
        const deregister = sinon.stub(
          CoprocessorFileManager.prototype,
          "deregisterCoprocessor"
        );
        deregister.returns(Promise.resolve(true));
        sinon
          .stub(CoprocessorFileManager.prototype, "readActiveCoprocessor")
          .returns(Promise.resolve(true));
        const [fakeServer, fakeSocket] = createFakeServer(() => {
          assert(apply.called);
          assert(handle.called);
          assert(deregister.called);
          fakeServer.closeCoprocessorManager().then(done).catch(done);
        }, true);
        const coprocessorRequest = createCoprocessorRequest("topicA");
        fakeSocket.emit("readable", coprocessorRequest);
      });
    });
  });
});
