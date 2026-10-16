from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class ReadRequest(StrictModel):
    relative_path: str = Field(min_length=1, max_length=500)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)

    @model_validator(mode="after")
    def check_range(self) -> Self:
        if self.end_line < self.start_line:
            raise ValueError("end_line 必须大于等于 start_line")
        return self


class Evidence(StrictModel):
    evidence_id: str = Field(pattern=r"^ev_[0-9a-f]{32}$")
    run_id: str = Field(min_length=1)
    path: str = Field(min_length=1)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    total_lines: int = Field(ge=1)
    file_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    code: str = Field(min_length=1, max_length=12000)
    truncated: bool
    next_line: int | None

    @model_validator(mode="after")
    def check_lines(self) -> Self:
        if not self.start_line <= self.end_line <= self.total_lines:
            raise ValueError("证据行区间无效")
        expected_next = self.end_line + 1 if self.truncated else None
        if self.next_line != expected_next:
            raise ValueError("next_line 与截断状态不一致")
        return self


class ToolError(StrictModel):
    code: str
    message: str
    retryable: bool = False


class ToolReply(StrictModel):
    schema_version: Literal["m1.v1"] = "m1.v1"
    run_id: str
    call_id: str
    status: Literal["ok", "partial", "error"]
    analysis_method: Literal["source_read"] = "source_read"
    data: Evidence | None
    evidence_ids: list[str]
    error: ToolError | None
    duration_ms: float = Field(ge=0)
    truncated: bool
    limitations: list[str]

    @model_validator(mode="after")
    def check_consistency(self) -> Self:
        if self.status == "error":
            if self.error is None or self.data is not None or self.evidence_ids:
                raise ValueError("失败结果的字段互相矛盾")
            if self.truncated:
                raise ValueError("失败结果不能伪装成可继续的截断证据")
        else:
            if self.error is not None or self.data is None:
                raise ValueError("成功结果必须包含证据且没有 error")
            if self.data.run_id != self.run_id:
                raise ValueError("证据不属于本次运行")
            if self.evidence_ids != [self.data.evidence_id]:
                raise ValueError("证据编号不一致")
            if self.truncated != self.data.truncated:
                raise ValueError("截断状态不一致")
            expected = "partial" if self.truncated else "ok"
            if self.status != expected:
                raise ValueError("status 与截断状态不一致")
        return self


